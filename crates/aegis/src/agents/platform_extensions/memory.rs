use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::tool_execution::ToolCallContext;
use crate::config::paths::Paths;
use anyhow::Result;
use async_trait::async_trait;
use indoc::indoc;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, Tool, ToolAnnotations,
};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

pub static EXTENSION_NAME: &str = "memory";
pub const MEMORY_WRITE_TOOL_NAME: &str = "memory_write";
pub const MEMORY_SEARCH_TOOL_NAME: &str = "memory_search";
pub const MEMORY_LIST_TOOL_NAME: &str = "memory_list";
pub const MEMORY_FORGET_TOOL_NAME: &str = "memory_forget";

/// Cuanto del archivo de hechos entra en cada turno. El digest es el punto de contacto con el
/// operador: si crece demasiado deja de ser memoria y pasa a ser impuesto de contexto.
const MOIM_MAX_CHARS: usize = 4_000;
const MOIM_MAX_FACTS: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Fact {
    id: String,
    text: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "default_confidence")]
    confidence: f32,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    created: String,
    #[serde(default)]
    updated: String,
    #[serde(default)]
    session: String,
}

fn default_confidence() -> f32 {
    0.8
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct MemoryWriteParams {
    /// Hecho durable, en una frase. Español, sin adornos. Ej: "Prefiere swaps inmediatos y odia esperas sin explicación".
    text: String,
    /// Categoria: preference, fact, goal, decision, style (default: fact).
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    /// Etiquetas libres para agrupar (ej: ["harness", "ui"]).
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    /// Confianza 0..1 (default 0.8). Usar menos de 0.6 para inferencias no confirmadas.
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<f32>,
    /// Si es true, entra siempre en el digest aunque haya hechos mas nuevos.
    #[serde(skip_serializing_if = "Option::is_none")]
    pinned: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct MemorySearchParams {
    /// Palabras a buscar (se compara en minusculas contra texto y etiquetas).
    query: String,
    /// Maximo de resultados (default: 10, max: 50).
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct MemoryListParams {
    /// Maximo de hechos a listar (default: 20, max: 100).
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<usize>,
    /// Filtrar por categoria.
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct MemoryForgetParams {
    /// Id del hecho a borrar (ej: F-0007).
    id: String,
}

pub struct MemoryClient {
    info: InitializeResult,
}

fn facts_path() -> PathBuf {
    Paths::in_data_dir("memory").join("facts.jsonl")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn read_facts() -> Vec<Fact> {
    let Ok(raw) = std::fs::read_to_string(facts_path()) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Fact>(line).ok())
        .collect()
}

fn write_facts(facts: &[Fact]) -> std::io::Result<()> {
    let path = facts_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        for fact in facts {
            let line = serde_json::to_string(fact).unwrap_or_default();
            writeln!(file, "{line}")?;
        }
        file.flush()?;
    }
    std::fs::rename(&tmp, &path)
}

fn next_id(facts: &[Fact]) -> String {
    let max = facts
        .iter()
        .filter_map(|f| f.id.strip_prefix("F-"))
        .filter_map(|n| n.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    format!("F-{:04}", max + 1)
}

fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

impl MemoryClient {
    pub fn new(_context: PlatformExtensionContext) -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(EXTENSION_NAME.to_string(), "1.0.0".to_string())
                    .with_title("Operator Memory"),
            )
            .with_instructions(
                indoc! {r#"
                Memoria durable del operador. Es lo que hace que cada sesion no empiece de cero.

                - `memory_write`: guarda un hecho estable sobre el operador o su entorno (preferencia,
                  decision tomada y su por que, dato del entorno, objetivo en curso). Escribi cuando
                  aprendas algo que seguiria siendo cierto dentro de un mes.
                - `memory_search` / `memory_list`: consultar antes de preguntar algo que ya te dijo.
                - `memory_forget`: borrar un hecho que quedo viejo o equivocado.

                No guardes estados transitorios (que archivo estas editando, que build corre).
                No guardes credenciales ni rutas de secretos.
                Los hechos con `pinned` entran en el digest de cada turno; el resto se consulta.
            "#}
                .to_string(),
            );

        Ok(Self { info })
    }

    fn tool_schema<T: JsonSchema>() -> serde_json::Map<String, serde_json::Value> {
        let schema = schema_for!(T);
        serde_json::to_value(schema)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn get_tools() -> Vec<Tool> {
        vec![
            Tool::new(
                MEMORY_WRITE_TOOL_NAME.to_string(),
                indoc! {r#"
                    Guarda un hecho durable sobre el operador o su entorno.

                    Usalo cuando aprendas algo que seguiria siendo cierto dentro de un mes: una
                    preferencia, una decision y su motivo, un dato del entorno, un objetivo.
                    Si el hecho ya existe, se actualiza en lugar de duplicarse.
                "#}
                .to_string(),
                Self::tool_schema::<MemoryWriteParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Record fact".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            )),
            Tool::new(
                MEMORY_SEARCH_TOOL_NAME.to_string(),
                "Busca hechos guardados por palabras. Devuelve id, categoria y texto.".to_string(),
                Self::tool_schema::<MemorySearchParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Search memory".to_string()),
                Some(true),
                Some(true),
                Some(false),
                Some(false),
            )),
            Tool::new(
                MEMORY_LIST_TOOL_NAME.to_string(),
                "Lista los hechos guardados, mas nuevos primero.".to_string(),
                Self::tool_schema::<MemoryListParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("List memory".to_string()),
                Some(true),
                Some(true),
                Some(false),
                Some(false),
            )),
            Tool::new(
                MEMORY_FORGET_TOOL_NAME.to_string(),
                "Borra un hecho por id.".to_string(),
                Self::tool_schema::<MemoryForgetParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Forget fact".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(true),
            )),
        ]
    }

    fn render(facts: &[Fact]) -> String {
        if facts.is_empty() {
            return "(sin hechos guardados todavia)".to_string();
        }
        facts
            .iter()
            .map(|f| {
                let mut line = format!("- [{}] {}", f.id, f.text);
                if !f.kind.is_empty() {
                    line.push_str(&format!(" ({}, conf {:.2})", f.kind, f.confidence));
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn handle_write(&self, session_id: &str, arguments: Option<JsonObject>) -> Result<Vec<ContentBlock>, String> {
        let args = arguments.as_ref().ok_or("Missing arguments")?;
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("Missing required parameter: text")?
            .to_string();

        let kind = args
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("fact")
            .to_string();
        let tags: Vec<String> = args
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let confidence = args
            .get("confidence")
            .and_then(|v| v.as_f64())
            .map(|v| v as f32)
            .unwrap_or_else(default_confidence)
            .clamp(0.0, 1.0);
        let pinned = args.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut facts = read_facts();
        let key = normalize(&text);
        let now = now_iso();

        if let Some(existing) = facts
            .iter_mut()
            .find(|f| normalize(&f.text) == key)
        {
            existing.updated = now;
            existing.confidence = confidence;
            existing.pinned = existing.pinned || pinned;
            for tag in tags {
                if !existing.tags.contains(&tag) {
                    existing.tags.push(tag);
                }
            }
            let id = existing.id.clone();
            write_facts(&facts).map_err(|e| format!("No se pudo escribir la memoria: {e}"))?;
            return Ok(vec![ContentBlock::text(format!(
                "Actualizado {id} ({} hechos en total)",
                facts.len()
            ))]);
        }

        let id = next_id(&facts);
        facts.push(Fact {
            id: id.clone(),
            text,
            kind,
            tags,
            confidence,
            pinned,
            created: now.clone(),
            updated: now,
            session: session_id.to_string(),
        });
        write_facts(&facts).map_err(|e| format!("No se pudo escribir la memoria: {e}"))?;
        Ok(vec![ContentBlock::text(format!(
            "Guardado {id} ({} hechos en total)",
            facts.len()
        ))])
    }

    fn handle_search(&self, arguments: Option<JsonObject>) -> Result<Vec<ContentBlock>, String> {
        let args = arguments.as_ref().ok_or("Missing arguments")?;
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(10)
            .clamp(1, 50) as usize;

        let terms: Vec<&str> = query.split_whitespace().collect();
        let facts = read_facts();
        let hits: Vec<&Fact> = facts
            .iter()
            .filter(|f| {
                let haystack = format!(
                    "{} {} {}",
                    f.text.to_lowercase(),
                    f.kind.to_lowercase(),
                    f.tags.join(" ").to_lowercase()
                );
                terms.iter().all(|term| haystack.contains(term))
            })
            .take(limit)
            .collect();

        if hits.is_empty() {
            return Ok(vec![ContentBlock::text(format!(
                "Sin resultados para \"{query}\"."
            ))]);
        }
        let owned: Vec<Fact> = hits.into_iter().cloned().collect();
        Ok(vec![ContentBlock::text(Self::render(&owned))])
    }

    fn handle_list(&self, arguments: Option<JsonObject>) -> Result<Vec<ContentBlock>, String> {
        let args = arguments.unwrap_or_default();
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20)
            .clamp(1, 100) as usize;
        let kind = args
            .get("kind")
            .and_then(|v| v.as_str())
            .map(|s| s.to_lowercase());

        let mut facts: Vec<Fact> = read_facts()
            .into_iter()
            .filter(|f| kind.as_ref().map(|k| f.kind.to_lowercase() == *k).unwrap_or(true))
            .collect();
        facts.sort_by(|a, b| b.updated.cmp(&a.updated));
        facts.truncate(limit);
        Ok(vec![ContentBlock::text(Self::render(&facts))])
    }

    fn handle_forget(&self, arguments: Option<JsonObject>) -> Result<Vec<ContentBlock>, String> {
        let args = arguments.as_ref().ok_or("Missing arguments")?;
        let id = args
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing required parameter: id")?
            .to_string();

        let mut facts = read_facts();
        let before = facts.len();
        facts.retain(|f| f.id != id);
        if facts.len() == before {
            return Ok(vec![ContentBlock::text(format!("No existe {id}."))]);
        }
        write_facts(&facts).map_err(|e| format!("No se pudo escribir la memoria: {e}"))?;
        Ok(vec![ContentBlock::text(format!(
            "Borrado {id} ({} hechos quedan)",
            facts.len()
        ))])
    }
}

#[async_trait]
impl McpClientTrait for MemoryClient {
    async fn list_tools(
        &self,
        _session_id: &str,
        _next_cursor: Option<String>,
        _cancellation_token: CancellationToken,
    ) -> Result<ListToolsResult, Error> {
        Ok(ListToolsResult {
            tools: Self::get_tools(),
            next_cursor: None,
            meta: None,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        ctx: &ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
        _cancellation_token: CancellationToken,
    ) -> Result<CallToolResult, Error> {
        let session_id = &ctx.session_id;
        let content = match name {
            MEMORY_WRITE_TOOL_NAME => self.handle_write(session_id, arguments),
            MEMORY_SEARCH_TOOL_NAME => self.handle_search(arguments),
            MEMORY_LIST_TOOL_NAME => self.handle_list(arguments),
            MEMORY_FORGET_TOOL_NAME => self.handle_forget(arguments),
            _ => Err(format!("Unknown tool: {}", name)),
        };

        match content {
            Ok(content) => Ok(CallToolResult::success(content)),
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: {}",
                error
            ))])),
        }
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }

    async fn get_moim(&self, _session_id: &str, _tools: &[Tool]) -> Option<String> {
        let mut facts = read_facts();
        if facts.is_empty() {
            return None;
        }

        // Pinned primero (identidad y reglas), despues lo mas reciente. El corte es por caracteres
        // para que el digest no crezca sin control.
        facts.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated.cmp(&a.updated))
        });

        let mut selected = Vec::new();
        let mut used = 0usize;
        for fact in facts.into_iter().take(MOIM_MAX_FACTS) {
            let cost = fact.text.chars().count() + 16;
            if used + cost > MOIM_MAX_CHARS {
                break;
            }
            used += cost;
            selected.push(fact);
        }

        if selected.is_empty() {
            return None;
        }

        Some(format!(
            "## Memoria del operador\n\n{}\n",
            Self::render(&selected)
        ))
    }
}
