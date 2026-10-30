// Compactación a pedido del modelo.
//
// Por qué existe: el modelo ve `<compaction>~Nk tokens remaining</compaction>` en el turn context y
// reaccionaba racionando trabajo ("me quedan 60k, debo ser eficiente"), que degrada la tarea. Desde
// acá puede decidir compactar y seguir tranquilo: pide la compactación con una tool y el turno
// siguiente arranca con el resumen en lugar del historial completo.
//
// Cómo funciona (sin tocar la conversación viva desde el handler, que no la tiene): la tool escribe
// una marca en el estado de la sesión y `CompactionOperation::run` la lee antes de evaluar el umbral.
// La marca se consume en el mismo turno en que se compacta, así que no puede quedar pegada.

use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::tool_execution::ToolCallContext;
use crate::session::extension_data::{CompactRequestState, ExtensionState};
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

pub static EXTENSION_NAME: &str = "compact";
pub const COMPACT_TOOL_NAME: &str = "compact_context";

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct CompactParams {
    /// Qué va a hacer después de compactar. Viaja al resumen como intención y evita que el modelo
    /// pierda el hilo del trabajo en curso.
    #[serde(default)]
    note: Option<String>,
}

pub struct CompactClient {
    info: InitializeResult,
    context: PlatformExtensionContext,
}

impl CompactClient {
    pub fn new(context: PlatformExtensionContext) -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(EXTENSION_NAME.to_string(), "1.0.0".to_string())
                    .with_title("Compact"),
            )
            .with_instructions(
                indoc! {r#"
                Compactá tu propio contexto cuando la ventana se esté llenando.

                No raciones el trabajo por los tokens que quedan: si la tarea necesita más espacio,
                llamá a esta tool y seguí. La compactación deja un resumen del historial y te
                devuelve margen; lo que el usuario ve no se borra (los mensajes originales quedan
                visibles para él, marcados como no vistos por vos).

                Usala ANTES de quedarte corto, no después de un error de contexto.
            "#}
                .to_string(),
            );

        Ok(Self { info, context })
    }

    async fn handle_compact(
        &self,
        session_id: &str,
        arguments: Option<JsonObject>,
    ) -> Result<Vec<ContentBlock>, String> {
        let note = arguments
            .as_ref()
            .and_then(|a| a.get("note"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let state = CompactRequestState {
            active: true,
            note,
            requested_at: Some(chrono::Utc::now().to_rfc3339()),
        };

        self.context
            .session_manager
            .set_extension_state(session_id, &state)
            .await
            .map_err(|_| "No se pudo registrar el pedido de compactación".to_string())?;

        Ok(vec![ContentBlock::text(
            indoc! {r#"
            Compactación pedida. Se aplica antes de la próxima inferencia de este turno.
            Seguí trabajando normal: no hace falta que reserves contexto ni que cortes la tarea.
        "#}
            .to_string(),
        )])
    }

    fn get_tools() -> Vec<Tool> {
        let schema = schema_for!(CompactParams);
        let schema_value =
            serde_json::to_value(schema).expect("Failed to serialize CompactParams schema");

        vec![Tool::new(
            COMPACT_TOOL_NAME.to_string(),
            indoc! {r#"
                Compactá el contexto de esta sesión: el historial se resume y recuperás ventana
                para seguir trabajando.

                Llamala cuando la ventana se esté llenando y la tarea pida más espacio. No la uses
                para "ahorrar" en medio de una tarea corta; sí cuando el trabajo vaya a necesitar
                muchas más lecturas, builds o turnos.

                Efecto: tu próxima inferencia ve un resumen en lugar del historial completo. Los
                mensajes originales siguen guardados y el usuario los sigue viendo.
            "#}
            .to_string(),
            schema_value.as_object().unwrap().clone(),
        )
        .annotate(ToolAnnotations::from_raw(
            Some("Compact context".to_string()),
            Some(false),
            Some(false),
            Some(false),
            Some(false),
        ))]
    }
}

#[async_trait]
impl McpClientTrait for CompactClient {
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
        let content = match name {
            COMPACT_TOOL_NAME => self.handle_compact(&ctx.session_id, arguments).await,
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

    async fn get_moim(&self, session_id: &str, _tools: &[Tool]) -> Option<String> {
        let metadata = self
            .context
            .session_manager
            .get_session(session_id, false)
            .await
            .ok()?;

        match CompactRequestState::from_extension_data(&metadata.extension_data) {
            Some(state) if state.active => Some(
                "Hay una compactación pendiente: se aplica antes de tu próxima inferencia.\n"
                    .to_string(),
            ),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_tool_se_declara_sin_prefijo_y_con_su_schema() {
        let tools = CompactClient::get_tools();
        assert_eq!(tools.len(), 1);
        let tool = &tools[0];
        assert_eq!(tool.name, COMPACT_TOOL_NAME);
        // El schema tiene el parametro opcional `note` y nada obligatorio.
        let schema = &tool.input_schema;
        assert!(schema.as_ref().contains_key("properties"));
        let requeridos = schema.get("required");
        assert!(
            requeridos.is_none() || requeridos == Some(&serde_json::json!([])),
            "la tool no debe exigir parametros: {requeridos:?}"
        );
    }

    #[test]
    fn el_estado_por_defecto_no_pide_compactar() {
        assert!(!CompactRequestState::default().is_pending());
        let pedido = CompactRequestState {
            active: true,
            note: Some("seguir con el build".to_string()),
            requested_at: Some("2026-10-28T12:00:00Z".to_string()),
        };
        assert!(pedido.is_pending());
        // Ida y vuelta por extension_data: es como lo lee CompactionOperation::compact_requested.
        let mut data = crate::session::ExtensionData::new();
        pedido.to_extension_data(&mut data).unwrap();
        let leido = CompactRequestState::from_extension_data(&data).expect("estado presente");
        assert!(leido.is_pending());
        assert_eq!(leido.note.as_deref(), Some("seguir con el build"));
    }
}
