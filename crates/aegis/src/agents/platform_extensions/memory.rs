//! Extension `memory`: las tools con las que el agente lee y escribe la memoria del operador.
//!
//! El store y sus reglas viven en `crate::memory::store`; aca solo estan los contratos de tool y el
//! digest que entra al prompt. La extraccion automatica al cierre de turno esta en
//! `crate::memory::extraction`.

use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::tool_execution::ToolCallContext;
use crate::memory::store::{self, Fact};
use anyhow::Result;
use async_trait::async_trait;
use indoc::indoc;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, Tool, ToolAnnotations,
};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub static EXTENSION_NAME: &str = "memory";
pub const MEMORY_WRITE_TOOL_NAME: &str = "memory_write";
pub const MEMORY_SEARCH_TOOL_NAME: &str = "memory_search";
pub const MEMORY_LIST_TOOL_NAME: &str = "memory_list";
pub const MEMORY_FORGET_TOOL_NAME: &str = "memory_forget";
pub const MEMORY_CONFIRM_TOOL_NAME: &str = "memory_confirm";
pub const MEMORY_CONSOLIDATE_TOOL_NAME: &str = "memory_consolidate";

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
    /// Filtrar por estado: candidate, confirmed, stale, rejected.
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct MemoryIdParams {
    /// Id del hecho (ej: F-0007).
    id: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct MemoryConsolidateParams {
    /// Si es true, ademas de consolidar regenera el informe. Default: true.
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<bool>,
}

pub struct MemoryClient {
    info: InitializeResult,
}

impl MemoryClient {
    pub fn new(_context: PlatformExtensionContext) -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(EXTENSION_NAME.to_string(), "2.0.0".to_string())
                    .with_title("Operator Memory"),
            )
            .with_instructions(
                indoc! {r#"
                Memoria durable del operador. Es lo que hace que cada sesion no empiece de cero.

                - `memory_write`: guarda un hecho estable sobre el operador o su entorno (preferencia,
                  decision tomada y su por que, dato del entorno, objetivo en curso). Escribi cuando
                  aprendas algo que seguiria siendo cierto dentro de un mes.
                - `memory_search` / `memory_list`: consultar antes de preguntar algo que ya te dijo.
                - `memory_forget`: marca un hecho como rechazado (queda el rastro, no entra al prompt).
                - `memory_confirm`: confirma un candidato que el extractor propuso.
                - `memory_consolidate`: deduplica, promueve candidatos repetidos y archiva lo viejo.

                Los hechos que el extractor infiere al cierre de cada turno entran como candidatos y
                no se inyectan hasta que se repiten en otra sesion o los confirmes.

                No guardes estados transitorios (que archivo estas editando, que build corre).
                No guardes credenciales ni rutas de secretos.
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

    fn read_only(
        name: &str,
        description: &str,
        schema: serde_json::Map<String, serde_json::Value>,
    ) -> Tool {
        Tool::new(name.to_string(), description.to_string(), schema).annotate(
            ToolAnnotations::from_raw(
                Some(name.to_string()),
                Some(true),
                Some(true),
                Some(false),
                Some(false),
            ),
        )
    }

    fn get_tools() -> Vec<Tool> {
        vec![
            Tool::new(
                MEMORY_WRITE_TOOL_NAME.to_string(),
                indoc! {r#"
                    Guarda un hecho durable sobre el operador o su entorno.

                    Usalo cuando aprendas algo que seguiria siendo cierto dentro de un mes: una
                    preferencia, una decision y su motivo, un dato del entorno, un objetivo.
                    Si el hecho ya existe, se actualiza y vuelve a quedar confirmado.
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
            Self::read_only(
                MEMORY_SEARCH_TOOL_NAME,
                "Busca hechos guardados por palabras. Devuelve id, categoria, estado y texto.",
                Self::tool_schema::<MemorySearchParams>(),
            ),
            Self::read_only(
                MEMORY_LIST_TOOL_NAME,
                "Lista los hechos guardados, mas nuevos primero. Filtra por categoria o estado.",
                Self::tool_schema::<MemoryListParams>(),
            ),
            Tool::new(
                MEMORY_FORGET_TOOL_NAME.to_string(),
                "Marca un hecho como rechazado: deja de entrar al prompt pero queda el rastro con su evidencia."
                    .to_string(),
                Self::tool_schema::<MemoryIdParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Reject fact".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            )),
            Tool::new(
                MEMORY_CONFIRM_TOOL_NAME.to_string(),
                "Confirma un candidato propuesto por el extractor para que entre al prompt.".to_string(),
                Self::tool_schema::<MemoryIdParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Confirm fact".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            )),
            Tool::new(
                MEMORY_CONSOLIDATE_TOOL_NAME.to_string(),
                "Consolida la memoria: fusiona duplicados, promueve candidatos con dos evidencias y archiva lo viejo."
                    .to_string(),
                Self::tool_schema::<MemoryConsolidateParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Consolidate memory".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            )),
        ]
    }

    fn render(facts: &[Fact]) -> String {
        if facts.is_empty() {
            return "(sin hechos guardados todavia)".to_string();
        }
        facts
            .iter()
            .map(store::render_line)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn handle_write(
        &self,
        session_id: &str,
        arguments: Option<JsonObject>,
    ) -> Result<Vec<ContentBlock>, String> {
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
            .unwrap_or(0.8)
            .clamp(0.0, 1.0);
        let pinned = args
            .get("pinned")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let path = store::store_path();
        let outcome =
            store::upsert_declared(&path, session_id, &text, &kind, tags, confidence, pinned)
                .map_err(|e| format!("No se pudo escribir la memoria: {e}"))?;
        let total = store::read_from(&path).len();
        let verb = if outcome.created {
            "Guardado"
        } else {
            "Actualizado"
        };
        Ok(vec![ContentBlock::text(format!(
            "{verb} {} ({total} hechos en total)",
            outcome.id
        ))])
    }

    fn handle_search(&self, arguments: Option<JsonObject>) -> Result<Vec<ContentBlock>, String> {
        let args = arguments.as_ref().ok_or("Missing arguments")?;
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(10)
            .clamp(1, 50) as usize;

        let hits = store::search(&store::read_from(&store::store_path()), &query, limit);
        if hits.is_empty() {
            return Ok(vec![ContentBlock::text(format!(
                "Sin resultados para \"{query}\"."
            ))]);
        }
        Ok(vec![ContentBlock::text(Self::render(&hits))])
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
        let status = args
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| s.to_lowercase());

        let mut facts: Vec<Fact> = store::read_from(&store::store_path())
            .into_iter()
            .filter(|f| {
                kind.as_ref()
                    .map(|k| f.kind.to_lowercase() == *k)
                    .unwrap_or(true)
            })
            .filter(|f| {
                status
                    .as_ref()
                    .map(|s| f.status.as_str() == s.as_str())
                    .unwrap_or(true)
            })
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
        let path = store::store_path();
        match store::reject(&path, &id)
            .map_err(|e| format!("No se pudo escribir la memoria: {e}"))?
        {
            true => Ok(vec![ContentBlock::text(format!(
                "Rechazado {id}: queda el rastro, ya no entra al prompt."
            ))]),
            false => Ok(vec![ContentBlock::text(format!("No existe {id}."))]),
        }
    }

    fn handle_confirm(&self, arguments: Option<JsonObject>) -> Result<Vec<ContentBlock>, String> {
        let args = arguments.as_ref().ok_or("Missing arguments")?;
        let id = args
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing required parameter: id")?
            .to_string();
        let path = store::store_path();
        match store::confirm(&path, &id)
            .map_err(|e| format!("No se pudo escribir la memoria: {e}"))?
        {
            true => Ok(vec![ContentBlock::text(format!("Confirmado {id}."))]),
            false => Ok(vec![ContentBlock::text(format!("No existe {id}."))]),
        }
    }

    fn handle_consolidate(&self) -> Result<Vec<ContentBlock>, String> {
        let report = store::consolidate(&store::store_path())
            .map_err(|e| format!("No se pudo consolidar la memoria: {e}"))?;
        let changed = if report.changed {
            "con cambios"
        } else {
            "sin cambios (idempotente)"
        };
        Ok(vec![ContentBlock::text(format!(
            "Memoria: {} hechos ({} confirmados, {} candidatos, {} stale, {} rechazados). Fusionados {}, promovidos {}. Corrida {changed}.",
            report.total,
            report.confirmed,
            report.candidates,
            report.stale,
            report.rejected,
            report.duplicates_merged,
            report.promoted.len()
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
            MEMORY_CONFIRM_TOOL_NAME => self.handle_confirm(arguments),
            MEMORY_CONSOLIDATE_TOOL_NAME => self.handle_consolidate(),
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
        store::digest(&store::read_from(&store::store_path()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_list_exposes_the_full_contract() {
        let names: Vec<String> = MemoryClient::get_tools()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        assert!(names.contains(&MEMORY_WRITE_TOOL_NAME.to_string()));
        assert!(names.contains(&MEMORY_SEARCH_TOOL_NAME.to_string()));
        assert!(names.contains(&MEMORY_LIST_TOOL_NAME.to_string()));
        assert!(names.contains(&MEMORY_FORGET_TOOL_NAME.to_string()));
        assert!(names.contains(&MEMORY_CONFIRM_TOOL_NAME.to_string()));
        assert!(names.contains(&MEMORY_CONSOLIDATE_TOOL_NAME.to_string()));
    }

    #[test]
    fn render_marks_status_and_confidence() {
        let fact = Fact {
            id: "F-0002".to_string(),
            text: "Prefiere tablas".to_string(),
            kind: "style".to_string(),
            tags: vec![],
            confidence: 0.4,
            pinned: false,
            status: store::Status::Candidate,
            source: store::Source::Inferred,
            evidence: vec!["s1: q".to_string()],
            created: String::new(),
            updated: String::new(),
            last_seen: String::new(),
            session: "s1".to_string(),
        };
        let line = store::render_line(&fact);
        assert!(line.contains("candidate"));
        assert!(line.contains("conf 0.40"));
        assert!(line.contains("evidencia 1"));
    }
}
