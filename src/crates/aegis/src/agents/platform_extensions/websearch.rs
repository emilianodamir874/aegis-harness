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
        let schema = |value: serde_json::Value| value.as_object().cloned().unwrap_or_default();
        vec![
            Tool::new(
                "web_search".to_string(),
                "Discover URLs you do not have yet. Use it as the FIRST step for any question about current or external facts: prices, releases, versions, docs, APIs, error messages, news, or anything that could have changed since your training. Do not answer those from memory because you half-remember them.\n\nOne call returns the engine that answered, ranked hits, and with `extract` the page text of the top results, so you usually do not need a second fetch. Tries Tavily (TAVILY_API_KEY), SearXNG (SEARXNG_URL), Mojeek, Bing and DuckDuckGo lite in order, and caches results for an hour.\n\nUse `web_fetch` instead when you already have the exact URL.".to_string(),
                schema(serde_json::to_value(schemars::schema_for!(WebSearchParams)).unwrap_or_default()),
            ),
            Tool::new(
                "web_fetch".to_string(),
                "Fetch one known URL and return its text without HTML boilerplate (cached for an hour). Use it when you already have the link: a docs page, a changelog, a raw file on GitHub, an API endpoint. If you do not have the URL yet, call web_search first: it already returns extracted text for the top results.\n\nJSON responses are returned as-is, so static JSON APIs (catalogs, price feeds, package metadata) work too. Prefer api.github.com, raw.githubusercontent.com and registry JSON over scraping a rendered page.".to_string(),
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

    async fn search(
        &self,
        query: &str,
        count: usize,
    ) -> std::result::Result<(String, Vec<SearchHit>), String> {
        let mut engines: Vec<(&str, EngineKind)> = Vec::new();
        if self.configured("TAVILY_API_KEY").is_some() {
            engines.push(("tavily", EngineKind::Tavily));
        }
        if self.configured("SEARXNG_URL").is_some() {
            engines.push(("searxng", EngineKind::Searxng));
        }
        // Orden por calidad comprobada: duckduckgo-lite devuelve titulo + URL real + resumen; mojeek y
        // bing quedan de respaldo (bing devolvia titulos con redirects /ck/a y sin descripcion, y como
        // ganaba el primero que traia algo, el resumen nunca llegaba).
        // Bing primero: es el unico que responde desde esta red (duckduckgo-lite devuelve su pagina
        // anti-bot "anomaly" y mojeek pide captcha), pero quedan de respaldo por si Bing cambia.
        engines.push(("bing", EngineKind::Bing));
        engines.push(("duckduckgo-lite", EngineKind::DuckDuckGoLite));
        engines.push(("mojeek", EngineKind::Mojeek));

        let mut problems: Vec<String> = Vec::new();
        let mut pobres: Option<(String, Vec<SearchHit>)> = None;
        for (name, kind) in engines {
            match self.run_engine(kind, query, count).await {
                Ok(hits) if hits.is_empty() => problems.push(format!("{name}: sin resultados")),
                Ok(hits) => {
                    // Resultado "bueno": al menos la mitad trae resumen y hay URLs reales (no /ck/a).
                    let con_resumen = hits.iter().filter(|h| !h.snippet.trim().is_empty()).count();
                    let urls_reales = hits
                        .iter()
                        .filter(|h| !h.url.is_empty() && !h.url.contains("/ck/a"))
                        .count();
                    if con_resumen * 2 >= hits.len() && urls_reales > 0 {
                        return Ok((name.to_string(), hits));
                    }
                    problems.push(format!(
                        "{name}: {} resultados pero con poco resumen ({con_resumen}/{} con descripcion)",
                        hits.len(),
                        hits.len()
                    ));
                    if pobres.is_none() {
                        pobres = Some((name.to_string(), hits));
                    }
                }
                Err(error) => problems.push(format!("{name}: {error}")),
            }
        }
        // Ningun motor trajo resumenes: devolvemos lo mejor que haya, antes de fallar.
        if let Some((name, hits)) = pobres {
            return Ok((name, hits));
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
                let key = self
                    .configured("TAVILY_API_KEY")
                    .ok_or("sin TAVILY_API_KEY")?;
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
                let url = format!(
                    "{}/search?q={}&format=json",
                    base.trim_end_matches('/'),
                    encode(query)
                );
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
                    .get_text(&format!(
                        "https://www.mojeek.com/search?q={}",
                        encode(query)
                    ))
                    .await?;
                Ok(parse_mojeek(&markup, count))
            }
            EngineKind::Bing => {
                // mkt=es-AR + setlang: sin esto Bing mezclaba resultados de otro mercado y de la
                // otra acepcion de la palabra (buscar "notebook" traia el producto Gemini Notebook).
                let markup = self
                    .get_text_como_navegador(&format!(
                        "https://www.bing.com/search?q={}&count={count}&mkt=es-AR&setlang=es",
                        encode(query)
                    ))
                    .await?;
                Ok(parse_bing(&markup, count))
            }
            EngineKind::DuckDuckGoLite => {
                let markup = self
                    .get_text(&format!(
                        "https://lite.duckduckgo.com/lite/?q={}",
                        encode(query)
                    ))
                    .await?;
                Ok(parse_duckduckgo_lite(&markup, count))
            }
        }
    }

    /// Igual que get_text pero presentandose como un navegador. Comprobado: sin User-Agent de
    /// navegador Bing devuelve una pagina de resultados genericos (aparecian dolarhoy/economipedia
    /// para una busqueda de notebooks) y con UA real devuelve los resultados correctos.
    async fn get_text_como_navegador(&self, url: &str) -> std::result::Result<String, String> {
        if let Some(cached) = self.cache_get(url) {
            return Ok(cached);
        }
        const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        let response = self
            .http
            .get(url)
            .header("user-agent", UA)
            .header("accept-language", "es-AR,es;q=0.9,en;q=0.8")
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let body = response.text().await.map_err(|error| error.to_string())?;
        self.cache_put(url, &body);
        Ok(body)
    }

    async fn get_text(&self, url: &str) -> std::result::Result<String, String> {
        if let Some(cached) = self.cache_get(url) {
            return Ok(cached);
        }
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| error.to_string())?;
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
        // APIs JSON: pasarlas por html_to_text las aplasta y queda un texto inservible. Si el cuerpo
        // arranca con { o [ se devuelve tal cual (acotado a max_chars): sirve para los catalogos y
        // precios que los sitios publican como JSON estatico (p.ej. static.compragamer.com/productos).
        let limpio = markup.trim_start();
        if limpio.starts_with('{') || limpio.starts_with('[') {
            return Ok(cortar_chars(limpio, max_chars));
        }
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

/// Corta por CARACTERES (no bytes) para no partir un UTF-8 al medio, y avisa si recorto.
fn cortar_chars(texto: &str, max_chars: usize) -> String {
    let total = texto.chars().count();
    if total <= max_chars {
        return texto.to_string();
    }
    let corte: String = texto.chars().take(max_chars).collect();
    format!("{corte}\n… (recortado: el cuerpo tenia {total} caracteres)")
}

/// Strips scripts, styles and tags, then collapses whitespace and entities.
pub fn html_to_text(markup: &str, max_chars: usize) -> String {
    let mut text = String::with_capacity(markup.len() / 2);
    let mut index = 0usize;
    while let Some(offset) = markup.get(index..).unwrap_or("").find('<') {
        let start = index + offset;
        text.push_str(markup.get(index..start).unwrap_or(""));
        let Some(close) = markup
            .get(start..)
            .unwrap_or("")
            .find('>')
            .map(|end| start + end + 1)
        else {
            text.push_str(markup.get(start..).unwrap_or(""));
            index = markup.len();
            break;
        };
        let tag = markup.get(start..close).unwrap_or("").to_ascii_lowercase();
        if tag.starts_with("<script") || tag.starts_with("<style") {
            let closing = if tag.starts_with("<script") {
                "</script"
            } else {
                "</style"
            };
            index = markup
                .get(close..)
                .unwrap_or("")
                .bytes()
                .enumerate()
                .filter(|(_, byte)| *byte == b'<')
                .map(|(offset, _)| close + offset)
                .find(|&start| {
                    markup
                        .get(start..)
                        .unwrap_or("")
                        .get(..closing.len())
                        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(closing))
                })
                .unwrap_or(close);
        } else {
            text.push(' ');
            index = close;
        }
    }
    if index < markup.len() {
        text.push_str(markup.get(index..).unwrap_or(""));
    }
    let decoded = unescape_entities(&text);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max_chars {
        collapsed.chars().take(max_chars).collect::<String>() + " [...]"
    } else {
        collapsed
    }
}

/// Bing y muchos sitios devuelven acentos y comillas como entidades numericas (&#250;, &#8217;).
/// Sin esto los titulos y resumenes salian con "&#250;" literal en lugar de la letra.
fn decode_numeric_entities(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'&' && i + 2 < bytes.len() && bytes[i + 1] == b'#' {
            let (inicio, hexa) = if bytes[i + 2] == b'x' || bytes[i + 2] == b'X' {
                (i + 3, true)
            } else {
                (i + 2, false)
            };
            let mut j = inicio;
            while j < bytes.len() && bytes[j] != b';' && j - inicio < 8 {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b';' && j > inicio {
                let cuerpo = value.get(inicio..j).unwrap_or("");
                let codigo = if hexa {
                    u32::from_str_radix(cuerpo, 16).ok()
                } else {
                    cuerpo.parse::<u32>().ok()
                };
                if let Some(caracter) = codigo.and_then(char::from_u32) {
                    out.push(caracter);
                    i = j + 1;
                    continue;
                }
            }
        }
        let caracter = value.get(i..).unwrap_or("").chars().next().unwrap_or('?');
        out.push(caracter);
        i += caracter.len_utf8();
    }
    out
}

/// Bing envuelve cada resultado en una redireccion https://www.bing.com/ck/a?...&u=a1<base64url>.
/// Devuelve el destino real; sin esto la busqueda devolvia redirects inservibles para citar.
fn desenvolver_enlace_bing(href: &str) -> String {
    let limpio = href.replace("&amp;", "&");
    if !limpio.contains("/ck/a") {
        return limpio;
    }
    let Some(posicion) = limpio.find("u=") else {
        return limpio;
    };
    let resto = limpio.get(posicion + 2..).unwrap_or("");
    let fin = resto.find('&').unwrap_or(resto.len());
    let crudo = percent_decode(resto.get(..fin).unwrap_or(""));
    let sin_prefijo = crudo
        .strip_prefix("a1")
        .unwrap_or(&crudo)
        .trim_end_matches('=');
    use base64::Engine as _;
    let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(sin_prefijo) else {
        return limpio;
    };
    let Ok(texto) = String::from_utf8(bytes) else {
        return limpio;
    };
    if texto.starts_with("http://") || texto.starts_with("https://") {
        texto
    } else {
        limpio
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(decodificado) = u8::from_str_radix(value.get(i + 1..i + 3).unwrap_or(""), 16)
            {
                out.push(decodificado);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn unescape_entities(value: &str) -> String {
    decode_numeric_entities(
        &value
            .replace("&nbsp;", " ")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&apos;", "'")
            .replace("&mdash;", "-")
            .replace("&ndash;", "-")
            .replace("&amp;", "&"),
    )
}

fn extract_attribute(tag: &str, attribute: &str) -> Option<String> {
    let needle = format!("{attribute}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag.get(start..).unwrap_or("").find('"')? + start;
    Some(unescape_entities(tag.get(start..end).unwrap_or("")))
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
        let Some(class_at) = rest.find(&needle) else {
            break;
        };
        let Some(anchor_at) = rest.get(..class_at).unwrap_or("").rfind("<a ") else {
            rest = rest.get(class_at + needle.len()..).unwrap_or("");
            continue;
        };
        let Some(open_end) = rest
            .get(anchor_at..)
            .unwrap_or("")
            .find('>')
            .map(|end| anchor_at + end)
        else {
            break;
        };
        let href = extract_attribute(rest.get(anchor_at..open_end).unwrap_or(""), "href")
            .unwrap_or_default();
        let Some(close) = rest
            .get(open_end..)
            .unwrap_or("")
            .find("</a>")
            .map(|end| open_end + end)
        else {
            break;
        };
        let title = html_to_text(rest.get(open_end + 1..close).unwrap_or(""), 200);
        if !href.is_empty() && !title.is_empty() {
            hits.push(SearchHit {
                title,
                url: absolute_url(&href),
                snippet: String::new(),
            });
        }
        rest = rest.get((close + 4).min(rest.len())..).unwrap_or("");
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
        let window = markup.get(at..(at + 6_000).min(markup.len())).unwrap_or("");
        let Some(class_at) = window.find(&needle) else {
            continue;
        };
        let Some(text_at) = window
            .get(class_at..)
            .unwrap_or("")
            .find('>')
            .map(|end| class_at + end + 1)
        else {
            continue;
        };
        let rest = window.get(text_at..).unwrap_or("");
        let stop = rest
            .find("</p>")
            .or_else(|| rest.find("</a>"))
            .or_else(|| rest.find("</td>"))
            .unwrap_or(rest.len());
        hit.snippet = html_to_text(rest.get(..stop).unwrap_or(""), 300);
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
        let Some(at) = markup
            .get(search_from..)
            .unwrap_or("")
            .find(marker)
            .map(|offset| search_from + offset)
        else {
            break;
        };
        let next = markup
            .get(at + marker.len()..)
            .unwrap_or("")
            .find(marker)
            .map(|offset| at + marker.len() + offset)
            .unwrap_or(markup.len());
        let block = markup.get(at..next).unwrap_or("");
        search_from = next;
        if let Some(mut hit) = first_anchor(block) {
            hit.snippet = snippet_del_bloque(block);
            hits.push(hit);
        }
    }
    if hits.is_empty() {
        hits = parse_h2_anchors(markup, count);
    }
    hits
}

/// El resumen de Bing vive dentro del propio bloque: <div class="b_caption"><p class="b_lineclamp2">
/// texto</p>. Antes se buscaba por clase en todo el documento y ya no encontraba nada.
fn snippet_del_bloque(block: &str) -> String {
    for marca in ["b_caption", "b_lineclamp"] {
        let Some(at) = block.find(marca) else {
            continue;
        };
        let Some(inicio) = block
            .get(at..)
            .unwrap_or("")
            .find('>')
            .map(|fin| at + fin + 1)
        else {
            continue;
        };
        let resto = block.get(inicio..).unwrap_or("");
        let fin = resto
            .find("</p>")
            .or_else(|| resto.find("</div>"))
            .unwrap_or(resto.len().min(600));
        let texto = html_to_text(resto.get(..fin).unwrap_or(""), 400);
        if !texto.is_empty() {
            return texto;
        }
    }
    String::new()
}

/// First anchor with an absolute href inside a block, with its stripped text as title.
fn first_anchor(block: &str) -> Option<SearchHit> {
    let anchor = block.find("<a ")?;
    let open_end = block
        .get(anchor..)
        .unwrap_or("")
        .find('>')
        .map(|end| anchor + end)?;
    let href = extract_attribute(block.get(anchor..open_end).unwrap_or(""), "href")?;
    if !href.starts_with("http") {
        return None;
    }
    let close = block
        .get(open_end..)
        .unwrap_or("")
        .find("</a>")
        .map(|end| open_end + end)?;
    let title = html_to_text(block.get(open_end + 1..close).unwrap_or(""), 200);
    if title.is_empty() {
        return None;
    }
    Some(SearchHit {
        title,
        url: desenvolver_enlace_bing(&href),
        snippet: String::new(),
    })
}

fn parse_h2_anchors(markup: &str, count: usize) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut rest = markup;
    while hits.len() < count {
        let Some(h2) = rest.find("<h2") else { break };
        let Some(head_at) = rest.get(h2..).unwrap_or("").find('>').map(|end| h2 + end) else {
            break;
        };
        let Some(close) = rest
            .get(head_at..)
            .unwrap_or("")
            .find("</h2>")
            .map(|end| head_at + end)
        else {
            break;
        };
        let block = rest.get(head_at + 1..close).unwrap_or("");
        if let Some(anchor) = block.find("<a ") {
            if let Some(open_end) = block
                .get(anchor..)
                .unwrap_or("")
                .find('>')
                .map(|end| anchor + end)
            {
                let href = extract_attribute(block.get(anchor..open_end).unwrap_or(""), "href")
                    .unwrap_or_default();
                let title = html_to_text(block.get(open_end + 1..).unwrap_or(""), 200);
                if href.starts_with("http") && !title.is_empty() {
                    hits.push(SearchHit {
                        title,
                        url: desenvolver_enlace_bing(&href),
                        snippet: String::new(),
                    });
                }
            }
        }
        rest = rest.get((close + 5).min(rest.len())..).unwrap_or("");
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
                Ok(CallToolResult::success(vec![ContentBlock::text(
                    render_search(&engine, &params.query, &hits, &extracted),
                )]))
            }
            "web_fetch" => {
                let params: WebFetchParams = match parse(arguments) {
                    Ok(params) => params,
                    Err(message) => return Ok(failure(message)),
                };
                if !params.url.starts_with("http") {
                    return Ok(failure(
                        "Error: url must start with http:// or https://".to_string(),
                    ));
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

fn parse<T: serde::de::DeserializeOwned>(
    arguments: Option<JsonObject>,
) -> std::result::Result<T, String> {
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
    fn html_to_text_handles_unicode_lowercase_expansion_without_panic() {
        let markup =
            "\u{0130}<STYLE>body{display:none}</STYLE>_visible_<SCRIPT>bad()</SCRIPT> after";
        let text = html_to_text(markup, 400);
        assert!(text.contains("_visible_"));
        assert!(text.contains("after"));
        assert!(!text.contains("display:none"));
        assert!(!text.contains("bad()"));
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
