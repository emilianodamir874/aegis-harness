//! Barrido de confirmaciones de tool que quedaron sin respuesta.
//!
//! Una confirmacion se pide con un mensaje `ActionRequired::ToolConfirmation` y se responde con
//! `ActionRequired::ToolConfirmationResponse` del mismo id. Si el proceso que la esperaba muere
//! (reinicio del serve, caida), la respuesta nunca llega: el turno queda huerfano y la sesion
//! aparece como trabada para siempre.
//!
//! Reemitir la tarjeta al cargar la sesion no sirve, porque el turno que la pidio ya no existe y
//! aprobar no despertaria a nadie. Lo que corresponde es cerrarlas: se escribe la respuesta como
//! `Permission::Cancel`, que es exactamente lo que significa — nadie aprobo nada y no se ejecuto.

use anyhow::Result;

use crate::conversation::message::{ActionRequiredData, Message, MessageContent};
use crate::permission::Permission;
use crate::session::SessionManager;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SweepReport {
    /// Sesiones revisadas que tenian al menos una confirmacion pedida.
    pub sessions_seen: usize,
    /// Confirmaciones que se cerraron en esta corrida.
    pub cancelled: usize,
    /// Pares (sesion, id) cerrados, para poder mostrarlos.
    pub detail: Vec<(String, String)>,
}

/// Cierra las confirmaciones pedidas que nunca recibieron respuesta.
///
/// Es idempotente: una confirmacion ya respondida no se vuelve a tocar, asi que correrlo dos veces
/// seguidas devuelve `cancelled: 0`.
pub async fn sweep_pending(manager: &SessionManager, apply: bool) -> Result<SweepReport> {
    let mut report = SweepReport::default();

    for session in manager.list_all_sessions().await? {
        let Ok(full) = manager.get_session(&session.id, true).await else {
            continue;
        };

        let Some(conversation) = full.conversation.as_ref() else {
            continue;
        };

        let mut pedidas: Vec<String> = Vec::new();
        let mut respondidas: Vec<String> = Vec::new();
        for message in conversation.messages() {
            for content in &message.content {
                let MessageContent::ActionRequired(action) = content else {
                    continue;
                };
                match &action.data {
                    ActionRequiredData::ToolConfirmation { id, .. } => pedidas.push(id.clone()),
                    ActionRequiredData::ToolConfirmationResponse { id, .. } => {
                        respondidas.push(id.clone())
                    }
                    _ => {}
                }
            }
        }

        if pedidas.is_empty() {
            continue;
        }
        report.sessions_seen += 1;

        for id in pedidas {
            if respondidas.contains(&id) {
                continue;
            }
            report.cancelled += 1;
            report.detail.push((session.id.clone(), id.clone()));
            if !apply {
                continue;
            }
            let mut message = Message::user();
            message.content.push(MessageContent::ActionRequired(
                crate::conversation::message::ActionRequired {
                    data: ActionRequiredData::ToolConfirmationResponse {
                        id,
                        permission: Permission::Cancel,
                    },
                },
            ));
            manager.add_message(&session.id, &message).await?;
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mensaje(data: ActionRequiredData) -> Message {
        let mut message = Message::assistant();
        message.content.push(MessageContent::ActionRequired(
            crate::conversation::message::ActionRequired { data },
        ));
        message
    }

    #[test]
    fn la_respuesta_usa_el_mismo_id_y_cancela() {
        let message = mensaje(ActionRequiredData::ToolConfirmationResponse {
            id: "call_1".to_string(),
            permission: Permission::Cancel,
        });
        match &message.content[0] {
            MessageContent::ActionRequired(action) => match &action.data {
                ActionRequiredData::ToolConfirmationResponse { id, permission } => {
                    assert_eq!(id, "call_1");
                    assert_eq!(permission, &Permission::Cancel);
                }
                otro => panic!("se esperaba una respuesta, llego {otro:?}"),
            },
            otro => panic!("se esperaba ActionRequired, llego {otro:?}"),
        }
    }
}
