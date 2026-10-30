use crate::acp::server::SessionBus;
use agent_client_protocol::schema::v1::{
    SessionId, SessionNotification, SessionUpdate, ToolCall, ToolCallUpdate,
};
use agent_client_protocol::{Client, ConnectionTo};

/// Emits tool-call notifications for a session.
///
/// It normally goes through the session bus, so a tool card started by the run
/// owner is also seen by every other watcher of the session (v6.4 fan-out).
/// The `connection_only` constructor is for replays that answer one specific
/// request (`session/load`), where fan-out would double-render the transcript.
#[derive(Clone)]
pub(crate) struct ToolCallNotifier {
    bus: Option<SessionBus>,
    connection: ConnectionTo<Client>,
    session_id: SessionId,
}

impl ToolCallNotifier {
    pub(crate) fn new(bus: &SessionBus, session_id: &SessionId) -> Self {
        Self {
            bus: Some(bus.clone()),
            connection: bus.connection().clone(),
            session_id: session_id.clone(),
        }
    }

    pub(crate) fn connection_only(
        connection: &ConnectionTo<Client>,
        session_id: &SessionId,
    ) -> Self {
        Self {
            bus: None,
            connection: connection.clone(),
            session_id: session_id.clone(),
        }
    }

    fn emit(&self, notification: SessionNotification) {
        match &self.bus {
            Some(bus) => bus.emit(self.session_id.0.as_ref(), notification),
            None => {
                let _ = self.connection.send_notification(notification);
            }
        }
    }

    pub(crate) fn send_initial(
        &self,
        tool_call: ToolCall,
    ) -> Result<(), agent_client_protocol::Error> {
        self.emit(SessionNotification::new(
            self.session_id.clone(),
            SessionUpdate::ToolCall(tool_call),
        ));
        Ok(())
    }

    pub(crate) fn send_update(
        &self,
        update: ToolCallUpdate,
    ) -> Result<(), agent_client_protocol::Error> {
        self.emit(SessionNotification::new(
            self.session_id.clone(),
            SessionUpdate::ToolCallUpdate(update),
        ));
        Ok(())
    }
}
