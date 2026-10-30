//! Extension `mode`: el agente puede cambiar el modo de la sesion (plan / revisar / ejecutar).
//!
//! Por que existe: el chip lo maneja el operador, pero el agente es el que sabe cuando la tarea pide
//! escribir. En `plan` no ve las tools de escritura, asi que sin esto quedaria trabado hasta que
//! alguien mueva el chip a mano.
//!
//! El agente decide el modo, sin escalera ni confirmaciones: el operador eligio quedar a merced del
//! modelo y no tener el chip en pantalla. El unico limite que queda es que el cambio aplica a la
//! sesion en curso, no al store: no toca `permission.yaml` ni las demas sesiones.
//!
//! El cambio usa los mismos overrides de sesion que el chip de la web (`PermissionManager` global):
//! no toca `permission.yaml` ni afecta a otras sesiones.

use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::config::permission::{global_permission_manager, PermissionLevel, PermissionManager};
use anyhow::Result;
use async_trait::async_trait;
use indoc::indoc;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, Tool, ToolAnnotations,
};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub static EXTENSION_NAME: &str = "mode";
pub const REQUEST_MODE_TOOL_NAME: &str = "request_mode";

const WRITE_TOOLS: [&str; 3] = ["shell", "edit", "write"];
const READ_ONLY_TOOLS: [&str; 10] = [
    "read_file",
    "grep",
    "tree",
    "read_image",
    "websearch__web_fetch",
    "websearch__web_search",
    "load_skill",
    "load",
    "chatrecall__chatrecall",
    "extensionmanager__search_available_extensions",
];

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct RequestModeParams {
    /// Modo pedido: `plan` (no escribir), `revisar` (cada escritura pide permiso) o `ejecutar`
    /// (permission.yaml manda).
    mode: String,
    /// Por que hace falta el cambio. Queda en el transcript como constancia.
    reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionMode {
    Plan,
    Revisar,
    Ejecutar,
}

impl SessionMode {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_lowercase().as_str() {
            "plan" => Some(Self::Plan),
            "revisar" | "review" => Some(Self::Revisar),
            "ejecutar" | "execute" | "auto" => Some(Self::Ejecutar),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Revisar => "revisar",
            Self::Ejecutar => "ejecutar",
        }
    }

    fn entries(self) -> Vec<(String, PermissionLevel)> {
        match self {
            Self::Ejecutar => Vec::new(),
            Self::Plan | Self::Revisar => {
                let nivel = if self == Self::Plan {
                    PermissionLevel::NeverAllow
                } else {
                    PermissionLevel::AskBefore
                };
                WRITE_TOOLS
                    .iter()
                    .map(|tool| (tool.to_string(), nivel.clone()))
                    .chain(
                        READ_ONLY_TOOLS
                            .iter()
                            .map(|tool| (tool.to_string(), PermissionLevel::AlwaysAllow)),
                    )
                    .collect()
            }
        }
    }
}

pub struct ModeClient {
    info: InitializeResult,
}

impl ModeClient {
    pub fn new(_context: PlatformExtensionContext) -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(EXTENSION_NAME.to_string(), "1.0.0".to_string())
                    .with_title("Session mode"),
            )
            .with_instructions(indoc! {r#"
                Modo de la sesion: `plan` no escribe, `revisar` pide permiso por escritura y `ejecutar`
                manda permission.yaml. Si no ves las tools de escritura es porque estas en `plan`; pedi
                `revisar` con `request_mode` cuando la tarea necesite escribir.
            "#});
        Ok(Self { info })
    }

    fn tool_schema<T: JsonSchema>() -> serde_json::Map<String, serde_json::Value> {
        let schema = schema_for!(T);
        serde_json::to_value(schema)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    fn manager() -> Option<Arc<PermissionManager>> {
        global_permission_manager()
    }

    fn current(session_id: &str) -> SessionMode {
        match Self::manager() {
            Some(manager) => Self::current_with(&manager, session_id),
            None => SessionMode::Ejecutar,
        }
    }

    fn apply(session_id: &str, mode: SessionMode) -> Result<(), String> {
        let manager = Self::manager().ok_or_else(|| {
            "el manager de permisos no esta disponible en esta sesion".to_string()
        })?;
        Self::apply_with(&manager, session_id, mode)
    }

    /// Version explicita para los tests: no depende del global del proceso, que se comparte entre
    /// tests en paralelo y hacia que se pisaran los overrides.
    fn current_with(manager: &PermissionManager, session_id: &str) -> SessionMode {
        match manager.session_permission_for_tool(session_id, "write") {
            Some(PermissionLevel::NeverAllow) => SessionMode::Plan,
            Some(PermissionLevel::AskBefore) => SessionMode::Revisar,
            _ => SessionMode::Ejecutar,
        }
    }

    fn apply_with(
        manager: &PermissionManager,
        session_id: &str,
        mode: SessionMode,
    ) -> Result<(), String> {
        manager.set_session_permissions(session_id, mode.entries());
        Ok(())
    }

    fn get_tools() -> Vec<Tool> {
        vec![Tool::new(
            REQUEST_MODE_TOOL_NAME.to_string(),
            indoc! {r#"
                Cambia el modo de esta sesion. Si no ves las tools de escritura (write, edit, shell) es
                porque estas en `plan`: pedi `revisar` o `ejecutar`.

                - `plan`: no podes escribir; las tools de escritura no se mandan.
                - `revisar`: cada escritura pide permiso al operador, con su diff.
                - `ejecutar`: permission.yaml manda.

                Cambia al modo que la tarea necesite. Si vas a leer y responder, `plan` alcanza; si vas
                a escribir, `revisar` deja que el operador apruebe cada cambio.
            "#}
            .to_string(),
            Self::tool_schema::<RequestModeParams>(),
        )
        .annotate(ToolAnnotations::from_raw(
            Some("Change session mode".to_string()),
            Some(false),
            Some(true),
            Some(false),
            Some(false),
        ))]
    }

    fn resolve(&self, session_id: &str, params: RequestModeParams) -> String {
        let Some(pedido) = SessionMode::parse(&params.mode) else {
            return format!(
                "Modo desconocido: {}. Usá plan, revisar o ejecutar.",
                params.mode
            );
        };
        let actual = Self::current(session_id);
        if pedido == actual {
            return format!("Ya estás en modo `{}`.", actual.name());
        }
        match Self::apply(session_id, pedido) {
            Ok(()) => format!(
                "Modo `{}` activo (motivo: {}). {}",
                pedido.name(),
                params.reason.trim(),
                match pedido {
                    SessionMode::Plan => "Las tools de escritura no se mandan al modelo.",
                    SessionMode::Revisar => "Cada escritura pide permiso con su diff.",
                    SessionMode::Ejecutar => "Manda permission.yaml.",
                }
            ),
            Err(error) => format!("No pude cambiar el modo: {error}"),
        }
    }
}

#[async_trait]
impl McpClientTrait for ModeClient {
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
        ctx: &crate::agents::tool_execution::ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
        _cancellation_token: CancellationToken,
    ) -> Result<CallToolResult, Error> {
        if name != REQUEST_MODE_TOOL_NAME {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: unknown tool {name}"
            ))]));
        }
        let params = match serde_json::from_value::<RequestModeParams>(serde_json::Value::Object(
            arguments.unwrap_or_default(),
        )) {
            Ok(params) => params,
            Err(error) => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "Error: parámetros inválidos: {error}"
                ))]))
            }
        };
        let texto = self.resolve(&ctx.session_id, params);
        Ok(CallToolResult::success(vec![ContentBlock::text(texto)]))
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn manager() -> (Arc<PermissionManager>, TempDir) {
        let dir = TempDir::new().unwrap();
        let manager = Arc::new(PermissionManager::new(dir.path().to_path_buf()));
        (manager, dir)
    }

    #[test]
    fn plan_bloquea_escritura_y_deja_lectura_libre() {
        let (manager, _dir) = manager();
        ModeClient::apply_with(&manager, "s", SessionMode::Plan).unwrap();
        assert_eq!(
            manager.session_permission_for_tool("s", "developer__write"),
            Some(PermissionLevel::NeverAllow)
        );
        assert_eq!(
            manager.session_permission_for_tool("s", "developer__read_file"),
            Some(PermissionLevel::AlwaysAllow)
        );
        assert_eq!(ModeClient::current_with(&manager, "s"), SessionMode::Plan);
    }

    #[test]
    fn ejecutar_borra_los_overrides() {
        let (manager, _dir) = manager();
        ModeClient::apply_with(&manager, "s", SessionMode::Revisar).unwrap();
        ModeClient::apply_with(&manager, "s", SessionMode::Ejecutar).unwrap();
        assert_eq!(
            manager.session_permission_for_tool("s", "developer__write"),
            None
        );
        assert_eq!(
            ModeClient::current_with(&manager, "s"),
            SessionMode::Ejecutar
        );
    }

    #[test]
    fn parse_acepta_los_tres_modos_y_rechaza_el_resto() {
        assert_eq!(SessionMode::parse("PLAN"), Some(SessionMode::Plan));
        assert_eq!(SessionMode::parse("revisar"), Some(SessionMode::Revisar));
        assert_eq!(SessionMode::parse(" auto "), Some(SessionMode::Ejecutar));
        assert_eq!(SessionMode::parse("yolo"), None);
    }
}
