//! Native web search and page fetch with a multi-engine fallback chain.
//!
//! Engines are tried in order and the answer reports which one replied: Tavily
//! (TAVILY_API_KEY), SearXNG (SEARXNG_URL), Mojeek, Bing and DuckDuckGo lite.
//! Results and pages are cached in-process for an hour, so a repeated query
//! or page costs nothing.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use async_trait::async_trait;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, Tool,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::ToolCallContext;
use crate::config::Config;

pub static EXTENSION_NAME: &str = "websearch";

const CACHE_TTL: Duration = Duration::from_secs(3600);
const SEARCH_MAX_RESULTS: usize = 10;
const FETCH_MAX_CHARS: usize = 20_000;
const EXTRACT_MAX_CHARS: usize = 2_500;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct WebSearchParams {
    /// Search query.
    pub query: String,
    /// Number of results to return (default 5, max 10).
    #[serde(default)]
    pub count: Option<usize>,
    /// Include the extracted text of the first N results (max 3).
    #[serde(default)]
    pub extract: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct WebFetchParams {
    /// Absolute http(s) URL.
    pub url: String,
    /// Maximum characters of extracted text (default 4000).
    #[serde(default)]
    pub max_chars: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Copy)]
enum EngineKind {
    Tavily,
    Searxng,
    Mojeek,
    Bing,
    DuckDuckGoLite,
}

pub struct WebSearchClient {
    info: InitializeResult,
    http: reqwest::Client,
    cache: Mutex<HashMap<String, (Instant, String)>>,
}

impl WebSearchClient {
    pub fn new(_context: PlatformExtensionContext) -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(EXTENSION_NAME, "1.0.0").with_title("Web Search"),
            );
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent("Mozilla/5.0 (compatible; aegis-websearch/1.0)")
            .build()?;
        Ok(Self {
            info,
            http,
            cache: Mutex::new(HashMap::new()),
        })
    }

    fn tools() -> Vec<Tool> {
        let schema = |value: serde_json::Value| {
            value
                .as_object()
                .cloned()
                .unwrap_or_default()
        };
        vec![
            Tool::new(
                "web_search".to_string(),
                "Search the web. Tries Tavily (TAVILY_API_KEY), SearXNG (SEARXNG_URL), Mojeek, Bing and DuckDuckGo lite in order, reports which engine answered, and caches results for an hour. Optional extract pulls the page text of the top results.".to_string(),
                schema(serde_json::to_value(schemars::schema_for!(WebSearchParams)).unwrap_or_default()),
            ),
            Tool::new(
                "web_fetch".to_string(),
                "Fetch a URL and return its text without HTML boilerplate (cached for an hour).".to_string(),
                schema(serde_json::to_value(schemars::schema_for!(WebFetchParams)).unwrap_or_default()),
            ),
        ]
    }

    fn cache_get(&self, key: &str) -> Option<String> {
        let cache = self.cache.lock().ok()?;
        let (stamp, value) = cache.get(key)?;
        if stamp.elapsed() > CACHE_TTL {
            return None;
        }
        Some(value.clone())
    }

    fn cache_put(&self, key: &str, value: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(key.to_string(), (Instant::now(), value.to_string()));
        }
    }

    fn configured(&self, key: &str) -> Option<String> {
        Config::global()
            .get_param::<String>(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    async fn search(&self, query: &str, count: usize) -> std::result::Result<(String, Vec<SearchHit>), String> {
        let mut engines: Vec<(&str, EngineKind)> = Vec::new();
        if self.configured("TAVILY_API_KEY").is_some() {
            engines.push(("tavily", EngineKind::Tavily));
        }
        if self.configured("SEARXNG_URL").is_some() {
            engines.push(("searxng", EngineKind::Searxng));
        }
        engines.push(("mojeek", EngineKind::Mojeek));
        engines.push(("bing", EngineKind::Bing));
        engines.push(("duckduckgo-lite", EngineKind::DuckDuckGoLite));

        let mut problems: Vec<String> = Vec::new();
        for (name, kind) in engines {
            match self.run_engine(kind, query, count).await {
                Ok(hits) if !hits.is_empty() => return Ok((name.to_string(), hits)),
                Ok(_) => problems.push(format!("{name}: sin resultados")),
                Err(error) => problems.push(format!("{name}: {error}")),
            }
        }
        Err(problems.join("; "))
    }

    async fn run_engine(
        &self,
        kind: EngineKind,
        query: &str,
        count: usize,
    ) -> std::result::Result<Vec<SearchHit>, String> {
        match kind {
            EngineKind::Tavily => {
                let key = self.configured("TAVILY_API_KEY").ok_or("sin TAVILY_API_KEY")?;
                let body = json!({ "query": query, "max_results": count });
                let payload: serde_json::Value = self
                    .http
                    .post("https://api.tavily.com/search")
                    .bearer_auth(key)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?
                    .json()
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(collect_json_hits(&payload, count))
            }
            EngineKind::Searxng => {
                let base = self.configured("SEARXNG_URL").ok_or("sin SEARXNG_URL")?;
                let url = format!("{}/search?q={}&format=json", base.trim_end_matches('/'), encode(query));
                let payload: serde_json::Value = self
                    .http
                    .get(url)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?
                    .json()
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(collect_json_hits(&payload, count))
            }
            EngineKind::Mojeek => {
                let markup = self
                    .get_text(&format!("https://www.mojeek.com/search?q={}", encode(query)))
                    .await?;
                Ok(parse_mojeek(&markup, count))
            }
            EngineKind::Bing => {
                let markup = self
                    .get_text(&format!("https://www.bing.com/search?q={}&count={count}", encode(query)))
                    .await?;
                Ok(parse_bing(&markup, count))
            }
            EngineKind::DuckDuckGoLite => {
                let markup = self
                    .get_text(&format!("https://lite.duckduckgo.com/lite/?q={}", encode(query)))
                    .await?;
                Ok(parse_duckduckgo_lite(&markup, count))
            }
        }
    }

    async fn get_text(&self, url: &str) -> std::result::Result<String, String> {
        if let Some(cached) = self.cache_get(url) {
            return Ok(cached);
        }
        let response = self.http.get(url).send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let body = response.text().await.map_err(|error| error.to_string())?;
        self.cache_put(url, &body);
        Ok(body)
    }

    async fn fetch_text(&self, url: &str, max_chars: usize) -> std::result::Result<String, String> {
        let markup = self.get_text(url).await?;
        Ok(html_to_text(&markup, max_chars))
    }
}

fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn collect_json_hits(payload: &serde_json::Value, count: usize) -> Vec<SearchHit> {
    payload["results"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .take(count)
                .map(|item| SearchHit {
                    title: item["title"].as_str().unwrap_or_default().to_string(),
                    url: item["url"].as_str().unwrap_or_default().to_string(),
                    snippet: item["content"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Strips scripts, styles and tags, then collapses whitespace and entities.
pub fn html_to_text(markup: &str, max_chars: usize) -> String {
    let lower = markup.to_lowercase();
    let mut text = String::with_capacity(markup.len() / 2);
    let mut index = 0usize;
    while let Some(offset) = lower[index..].find('<') {
        let start = index + offset;
        text.push_str(&markup[index..start]);
        let Some(close) = lower[start..].find('>').map(|end| start + end + 1) else {
            text.push_str(&markup[start..]);
            index = markup.len();
            break;
        };
        let tag = &lower[start..close];
        if tag.starts_with("<script") || tag.starts_with("<style") {
            let closing = if tag.starts_with("<script") { "</script" } else { "</style" };
            index = lower[close..].find(closing).map(|end| close + end).unwrap_or(close);
        } else {
            text.push(' ');
            index = close;
        }
    }
    if index < markup.len() {
        text.push_str(&markup[index..]);
    }
    let decoded = unescape_entities(&text);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max_chars {
        collapsed.chars().take(max_chars).collect::<String>() + " [...]"
    } else {
        collapsed
    }
}

fn unescape_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&mdash;", "-")
        .replace("&ndash;", "-")
        .replace("&amp;", "&")
}

fn extract_attribute(tag: &str, attribute: &str) -> Option<String> {
    let needle = format!("{attribute}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(unescape_entities(&tag[start..end]))
}

fn absolute_url(href: &str) -> String {
    match href.strip_prefix("//") {
        Some(rest) => format!("https://{rest}"),
        None => href.to_string(),
    }
}

/// Every anchor whose class matches, in document order.
fn parse_anchors(markup: &str, class: &str, count: usize) -> Vec<SearchHit> {
    let needle = format!("class=\"{class}\"");
    let mut hits = Vec::new();
    let mut rest = markup;
    while hits.len() < count {
        let Some(class_at) = rest.find(&needle) else { break };
        let Some(anchor_at) = rest[..class_at].rfind("<a ") else {
            rest = &rest[class_at + needle.len()..];
            continue;
        };
        let Some(open_end) = rest[anchor_at..].find('>').map(|end| anchor_at + end) else {
            break;
        };
        let href = extract_attribute(&rest[anchor_at..open_end], "href").unwrap_or_default();
        let Some(close) = rest[open_end..].find("</a>").map(|end| open_end + end) else {
            break;
        };
        let title = html_to_text(&rest[open_end + 1..close], 200);
        if !href.is_empty() && !title.is_empty() {
            hits.push(SearchHit {
                title,
                url: absolute_url(&href),
                snippet: String::new(),
            });
        }
        rest = &rest[(close + 4).min(rest.len())..];
    }
    hits
}

/// Fills snippets by looking for the snippet class shortly after each link.
fn fill_snippets(markup: &str, hits: &mut [SearchHit], snippet_class: &str) {
    let needle = format!("class=\"{snippet_class}\"");
    for hit in hits.iter_mut() {
        let marker = hit.url.replace("https://", "//");
        let Some(at) = markup.find(&marker).or_else(|| markup.find(&hit.url)) else {
            continue;
        };
        let window = &markup[at..(at + 6_000).min(markup.len())];
        let Some(class_at) = window.find(&needle) else { continue };
        let Some(text_at) = window[class_at..].find('>').map(|end| class_at + end + 1) else {
            continue;
        };
        let rest = &window[text_at..];
        let stop = rest.find("</p>").or_else(|| rest.find("</a>")).or_else(|| rest.find("</td>")).unwrap_or(rest.len());
        hit.snippet = html_to_text(&rest[..stop], 300);
    }
}

pub fn parse_mojeek(markup: &str, count: usize) -> Vec<SearchHit> {
    let mut hits = parse_anchors(markup, "ob", count);
    fill_snippets(markup, &mut hits, "s");
    hits
}

pub fn parse_bing(markup: &str, count: usize) -> Vec<SearchHit> {
    // Bing puts the result class on the <li>, not on the anchor, so each result is
    // parsed as a block: the first <a href> inside carries the title.
    let marker = "class=\"b_algo\"";
    let mut hits = Vec::new();
    let mut search_from = 0usize;
    while hits.len() < count {
        let Some(at) = markup[search_from..].find(marker).map(|offset| search_from + offset) else {
            break;
        };
        let next = markup[at + marker.len()..]
            .find(marker)
            .map(|offset| at + marker.len() + offset)
            .unwrap_or(markup.len());
        let block = &markup[at..next];
        search_from = next;
        if let Some(hit) = first_anchor(block) {
            hits.push(hit);
        }
    }
    if hits.is_empty() {
        hits = parse_h2_anchors(markup, count);
    }
    fill_snippets(markup, &mut hits, "b_lineclamp");
    hits
}

/// First anchor with an absolute href inside a block, with its stripped text as title.
fn first_anchor(block: &str) -> Option<SearchHit> {
    let anchor = block.find("<a ")?;
    let open_end = block[anchor..].find('>').map(|end| anchor + end)?;
    let href = extract_attribute(&block[anchor..open_end], "href")?;
    if !href.starts_with("http") {
        return None;
    }
    let close = block[open_end..].find("</a>").map(|end| open_end + end)?;
    let title = html_to_text(&block[open_end + 1..close], 200);
    if title.is_empty() {
        return None;
    }
    Some(SearchHit {
        title,
        url: href,
        snippet: String::new(),
    })
}

fn parse_h2_anchors(markup: &str, count: usize) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut rest = markup;
    while hits.len() < count {
        let Some(h2) = rest.find("<h2") else { break };
        let Some(head_at) = rest[h2..].find('>').map(|end| h2 + end) else { break };
        let Some(close) = rest[head_at..].find("</h2>").map(|end| head_at + end) else { break };
        let block = &rest[head_at + 1..close];
        if let Some(anchor) = block.find("<a ") {
            if let Some(open_end) = block[anchor..].find('>').map(|end| anchor + end) {
                let href = extract_attribute(&block[anchor..open_end], "href").unwrap_or_default();
                let title = html_to_text(&block[open_end + 1..], 200);
                if href.starts_with("http") && !title.is_empty() {
                    hits.push(SearchHit { title, url: href, snippet: String::new() });
                }
            }
        }
        rest = &rest[(close + 5).min(rest.len())..];
    }
    hits
}

pub fn parse_duckduckgo_lite(markup: &str, count: usize) -> Vec<SearchHit> {
    let mut hits = parse_anchors(markup, "result-link", count);
    fill_snippets(markup, &mut hits, "result-snippet");
    hits
}

fn render_search(
    engine: &str,
    query: &str,
    hits: &[SearchHit],
    extracted: &[(String, String)],
) -> String {
    let mut out = format!("{query} :: {engine} :: {} resultados\n", hits.len());
    for (index, hit) in hits.iter().enumerate() {
        out.push_str(&format!("\n{}. {}\n   {}\n", index + 1, hit.title, hit.url));
        if !hit.snippet.is_empty() {
            out.push_str(&format!("   {}\n", hit.snippet));
        }
        if let Some((_, text)) = extracted.iter().find(|(url, _)| url == &hit.url) {
            out.push_str("   ---\n");
            for line in text.lines().take(20) {
                out.push_str(&format!("   {line}\n"));
            }
        }
    }
    out
}

#[async_trait]
impl McpClientTrait for WebSearchClient {
    async fn list_tools(
        &self,
        _session_id: &str,
        _next_cursor: Option<String>,
        _cancellation_token: CancellationToken,
    ) -> Result<ListToolsResult, Error> {
        Ok(ListToolsResult {
            tools: Self::tools(),
            next_cursor: None,
            meta: None,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        _ctx: &ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
        _cancellation_token: CancellationToken,
    ) -> Result<CallToolResult, Error> {
        let failure = |message: String| CallToolResult::error(vec![ContentBlock::text(message)]);
        match name {
            "web_search" => {
                let params: WebSearchParams = match parse(arguments) {
                    Ok(params) => params,
                    Err(message) => return Ok(failure(message)),
                };
                let count = params.count.unwrap_or(5).clamp(1, SEARCH_MAX_RESULTS);
                let extract = params.extract.unwrap_or(0).min(3);
                let (engine, hits) = match self.search(&params.query, count).await {
                    Ok(result) => result,
                    Err(problems) => {
                        return Ok(failure(format!(
                            "No engine returned results for {:?}: {problems}",
                            params.query
                        )))
                    }
                };
                let mut extracted = Vec::new();
                for hit in hits.iter().take(extract) {
                    if let Ok(text) = self.fetch_text(&hit.url, EXTRACT_MAX_CHARS).await {
                        extracted.push((hit.url.clone(), text));
                    }
                }
                Ok(CallToolResult::success(vec![ContentBlock::text(render_search(
                    &engine,
                    &params.query,
                    &hits,
                    &extracted,
                ))]))
            }
            "web_fetch" => {
                let params: WebFetchParams = match parse(arguments) {
                    Ok(params) => params,
                    Err(message) => return Ok(failure(message)),
                };
                if !params.url.starts_with("http") {
                    return Ok(failure("Error: url must start with http:// or https://".to_string()));
                }
                let max_chars = params.max_chars.unwrap_or(4_000).min(FETCH_MAX_CHARS);
                match self.fetch_text(&params.url, max_chars).await {
                    Ok(text) => Ok(CallToolResult::success(vec![ContentBlock::text(format!(
                        "{} :: {} chars\n{}",
                        params.url,
                        text.chars().count(),
                        text
                    ))])),
                    Err(error) => Ok(failure(format!("Error fetching {}: {error}", params.url))),
                }
            }
            other => Ok(failure(format!("Error: Unknown tool: {other}"))),
        }
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }
}

fn parse<T: serde::de::DeserializeOwned>(arguments: Option<JsonObject>) -> std::result::Result<T, String> {
    let value = match arguments {
        Some(arguments) => serde_json::Value::Object(arguments),
        None => return Err("Error: missing arguments".to_string()),
    };
    serde_json::from_value(value).map_err(|error| format!("Error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOJEEK_HTML: &str = "<ul><li><a class=\"ob\" href=\"https://example.org/a\">Ejemplo A</a><p class=\"s\">Un resumen de <b>A</b>.</p></li><li><a class=\"ob\" href=\"//example.org/b\">Ejemplo B</a><p class=\"s\">Resumen B.</p></li></ul>";

    const BING_HTML: &str = "<ol><li class=\"b_algo\"><h2><a href=\"https://example.net/1\">Uno</a></h2><p class=\"b_lineclamp\">Texto del uno.</p></li><li class=\"b_algo\"><h2><a href=\"https://example.net/2\">Dos</a></h2></li></ol>";

    const DDG_LITE_HTML: &str = "<table><tr><td><a class=\"result-link\" href=\"https://example.com/x\">Resultado X</a></td></tr><tr><td class=\"result-snippet\">Snippet de X.</td></tr></table>";

    #[test]
    fn mojeek_parser_reads_titles_urls_and_snippets() {
        let hits = parse_mojeek(MOJEEK_HTML, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Ejemplo A");
        assert_eq!(hits[0].url, "https://example.org/a");
        assert!(hits[0].snippet.contains("Un resumen"));
        assert_eq!(hits[1].url, "https://example.org/b");
    }

    #[test]
    fn bing_parser_reads_titles_and_snippets() {
        let hits = parse_bing(BING_HTML, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://example.net/1");
        assert!(hits[0].snippet.contains("Texto del uno"));
        assert_eq!(hits[1].title, "Dos");
    }

    #[test]
    fn duckduckgo_lite_parser_reads_links() {
        let hits = parse_duckduckgo_lite(DDG_LITE_HTML, 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com/x");
        assert!(hits[0].snippet.contains("Snippet de X"));
    }

    #[test]
    fn html_to_text_drops_scripts_and_normalises_entities() {
        let markup = "<html><head><style>p{color:red}</style><script>var a = 1;</script></head><body><h1>Titulo</h1><p>uno &amp; dos &lt;tres&gt;&nbsp;cuatro</p></body></html>";
        let text = html_to_text(markup, 400);
        assert!(!text.contains("color:red"));
        assert!(!text.contains("var a"));
        assert!(text.contains("uno & dos <tres> cuatro"), "texto: {text}");
        assert!(text.contains("Titulo"));
    }

    #[test]
    fn html_to_text_respects_the_character_cap() {
        let markup = format!("<p>{}</p>", "palabra ".repeat(100));
        let text = html_to_text(&markup, 50);
        assert!(text.chars().count() <= 50 + 7);
        assert!(text.ends_with(" [...]"));
    }

    #[test]
    fn render_search_reports_engine_count_and_extracted_text() {
        let hits = vec![SearchHit {
            title: "T".to_string(),
            url: "https://x".to_string(),
            snippet: "s".to_string(),
        }];
        let rendered = render_search(
            "mojeek",
            "consulta",
            &hits,
            &[("https://x".to_string(), "cuerpo extraido".to_string())],
        );
        assert!(rendered.contains("mojeek"));
        assert!(rendered.contains("1 resultados"));
        assert!(rendered.contains("cuerpo extraido"));
    }

    #[test]
    fn encode_builds_a_query_string() {
        assert_eq!(encode("aegis ai"), "aegis+ai");
        assert_eq!(encode("c++ & rust"), "c%2B%2B+%26+rust");
    }
}
