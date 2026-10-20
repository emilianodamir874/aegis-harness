use super::*;
use crate::conversation::rewind::{self, Turn};

/// Which turn a rewind request points at, resolved against the turns the model
/// can still see.
#[derive(Debug, PartialEq, Eq)]
enum Target {
    /// Position inside the collected `turns`.
    Position(usize),
    NoTurns,
    UnknownMessageId,
    BackOutOfRange,
}

/// `message_id` wins when both are given; `back` defaults to the last turn.
fn resolve_target(turns: &[Turn], message_id: Option<&str>, back: Option<u32>) -> Target {
    if turns.is_empty() {
        return Target::NoTurns;
    }
    if let Some(message_id) = message_id {
        return turns
            .iter()
            .position(|turn| turn.message_id == message_id)
            .map(Target::Position)
            .unwrap_or(Target::UnknownMessageId);
    }
    match rewind::resolve_back(turns, back.unwrap_or(1) as usize) {
        Some(message_index) => turns
            .iter()
            .position(|turn| turn.message_index == message_index)
            .map(Target::Position)
            .unwrap_or(Target::BackOutOfRange),
        None => Target::BackOutOfRange,
    }
}

impl AegisAcpAgent {
    /// `_aegis/unstable/session/retry` — rewind the last turn and set the profile atomically.
    pub(super) async fn on_retry_last_turn(
        &self,
        req: RetryLastTurnRequest,
    ) -> Result<RetryLastTurnResponse, agent_client_protocol::Error> {
        let session_id = req.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("sessionId cannot be empty")
            );
        }

        let rewound = self
            .on_rewind_session(RewindSessionRequest {
                session_id: session_id.clone(),
                message_id: None,
                back: Some(1),
            })
            .await?;

        let profile = match req
            .profile
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            Some(profile) => {
                self.session_manager
                    .set_frame_profile(&session_id, profile)
                    .await
                    .internal_err_ctx("Failed to set the frame profile")?;
                profile.to_string()
            }
            None => {
                FrameProfileState::of(
                    &self
                        .session_manager
                        .get_session(&session_id, false)
                        .await
                        .internal_err_ctx("Failed to read the session")?,
                )
                .profile
            }
        };

        Ok(RetryLastTurnResponse {
            text: rewound.text,
            preview: rewound.preview,
            hidden: rewound.hidden,
            profile,
        })
    }

    /// `_aegis/unstable/session/unrewind` — undo the most recent rewind.
    pub(super) async fn on_unrewind_session(
        &self,
        req: UnrewindSessionRequest,
    ) -> Result<UnrewindSessionResponse, agent_client_protocol::Error> {
        let session_id = req.session_id.trim();
        if session_id.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("sessionId cannot be empty")
            );
        }
        if self.active_runs.agent_run(session_id).is_some() {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("cannot unrewind while a run is active for this session"));
        }

        let session = self
            .session_manager
            .get_session(session_id, true)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {session_id}"))
            })?;
        let conversation = session.conversation.unwrap_or_else(Conversation::empty);

        let restored =
            rewind::show_tail_after_last_visible(&self.session_manager, session_id, &conversation)
                .await
                .internal_err_ctx("Failed to restore the rewound tail")?;

        Ok(UnrewindSessionResponse {
            restored: restored as u32,
        })
    }

    /// `_aegis/unstable/session/rewind` — stop sending everything from an
    /// earlier user turn on, and hand that turn's text back for editing.
    ///
    /// Nothing is deleted: the messages stay in the store (and in the client's
    /// transcript) and only lose `agent_visible`, exactly like the rows a
    /// compaction replaced.
    pub(super) async fn on_rewind_session(
        &self,
        req: RewindSessionRequest,
    ) -> Result<RewindSessionResponse, agent_client_protocol::Error> {
        let session_id = req.session_id.trim();
        if session_id.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("sessionId cannot be empty")
            );
        }
        if self.active_runs.agent_run(session_id).is_some() {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("cannot rewind while a run is active for this session"));
        }
        if req.message_id.is_none() && req.back.is_none() {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("either messageId or back is required"));
        }

        let session = self
            .session_manager
            .get_session(session_id, true)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {session_id}"))
            })?;
        let conversation = session.conversation.unwrap_or_else(Conversation::empty);
        let turns = rewind::collect_turns(&conversation);

        let position = match resolve_target(&turns, req.message_id.as_deref(), req.back) {
            Target::Position(position) => position,
            Target::NoTurns => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("nothing to rewind: no user turns the model can see"))
            }
            Target::UnknownMessageId => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("messageId is not a user turn the model can currently see"))
            }
            Target::BackOutOfRange => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data(format!("only {} rewindable turn(s) available", turns.len())))
            }
        };
        let turn = &turns[position];

        let hidden = rewind::hide_tail_from(
            &self.session_manager,
            session_id,
            &conversation,
            turn.message_index,
        )
        .await
        .internal_err_ctx("Failed to rewind the session conversation")?;

        Ok(RewindSessionResponse {
            hidden: hidden as u32,
            message_id: turn.message_id.clone(),
            preview: turn.preview.clone(),
            text: turn.text.clone(),
            // Every turn before this one is still something the model can see.
            remaining_turns: position as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(index: usize, id: &str) -> Turn {
        Turn {
            message_index: index,
            message_id: id.to_string(),
            preview: id.to_string(),
            text: id.to_string(),
        }
    }

    fn turns() -> Vec<Turn> {
        vec![turn(0, "u1"), turn(4, "u2"), turn(9, "u3")]
    }

    #[test]
    fn message_id_selects_that_turn() {
        assert_eq!(
            resolve_target(&turns(), Some("u2"), None),
            Target::Position(1)
        );
        assert_eq!(
            resolve_target(&turns(), Some("u1"), Some(3)),
            Target::Position(0),
            "messageId wins over back"
        );
    }

    #[test]
    fn back_counts_from_the_end_and_defaults_to_the_last_turn() {
        let turns = turns();
        assert_eq!(resolve_target(&turns, None, Some(1)), Target::Position(2));
        assert_eq!(resolve_target(&turns, None, Some(3)), Target::Position(0));
        assert_eq!(resolve_target(&turns, None, None), Target::Position(2));
        assert_eq!(
            resolve_target(&turns, None, Some(0)),
            Target::BackOutOfRange
        );
        assert_eq!(
            resolve_target(&turns, None, Some(4)),
            Target::BackOutOfRange
        );
    }

    #[test]
    fn unknown_ids_and_empty_conversations_are_reported() {
        assert_eq!(
            resolve_target(&turns(), Some("nope"), None),
            Target::UnknownMessageId
        );
        assert_eq!(resolve_target(&[], Some("u1"), None), Target::NoTurns);
        assert_eq!(resolve_target(&[], None, Some(1)), Target::NoTurns);
    }
}
