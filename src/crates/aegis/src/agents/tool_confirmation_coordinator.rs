use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::sync::{Mutex, Notify, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::agents::extension_manager::ExtensionLease;
use crate::permission::Permission;

/// Default wait for a tool confirmation before the turn is released.
const DEFAULT_CONFIRMATION_TIMEOUT_SECS: u64 = 600;

/// Resolves the confirmation timeout: `AEGIS_CONFIRMATION_TIMEOUT_SECS` when set to a
/// positive integer, otherwise the default. `0` disables the timeout on purpose.
pub(super) fn confirmation_timeout_secs(override_secs: Option<u64>) -> u64 {
    if let Some(secs) = override_secs.filter(|secs| *secs > 0) {
        return secs;
    }
    std::env::var("AEGIS_CONFIRMATION_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_CONFIRMATION_TIMEOUT_SECS)
}

/// Sleeps for the configured timeout, or forever when the timeout is disabled.
async fn wait_timeout(timeout: Option<Duration>) {
    match timeout {
        Some(duration) => tokio::time::sleep(duration).await,
        None => std::future::pending::<()>().await,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ConfirmationAnswer {
    LiveHandled,
    StateMachine(Permission),
}

pub(super) struct SessionToolConfirmationState {
    // Held for the lifetime of one Agent::reply stream, including confirmation waits and resumes.
    turn_lock: Arc<Mutex<()>>,
    // Serializes submit_tool_confirmation so concurrent answers cannot both be accepted.
    pub(super) confirmation_submission_lock: Mutex<()>,
    // Tracks requests from the current confirmation pause; None means still unanswered.
    confirmations: StdMutex<HashMap<String, Option<ConfirmationAnswer>>>,
    extension_lease: Arc<StdMutex<Option<Arc<ExtensionLease>>>>,
    // Wakes wait_for_all_confirmation_answers; confirmations remains the source of truth.
    confirmation_answered: Notify,
}

impl SessionToolConfirmationState {
    fn new() -> Self {
        Self {
            turn_lock: Arc::new(Mutex::new(())),
            confirmation_submission_lock: Mutex::new(()),
            confirmations: StdMutex::new(HashMap::new()),
            extension_lease: Arc::new(StdMutex::new(None)),
            confirmation_answered: Notify::new(),
        }
    }

    pub(super) fn try_start_turn(self: &Arc<Self>) -> Result<ActiveTurnGuard> {
        let turn_lock_guard = self
            .turn_lock
            .clone()
            .try_lock_owned()
            .map_err(|_| anyhow!("session already has an active turn"))?;
        Ok(ActiveTurnGuard {
            state: self.clone(),
            _turn_lock_guard: turn_lock_guard,
        })
    }

    pub(super) fn register_request(&self, request_id: String) {
        self.confirmations
            .lock()
            .expect("tool confirmation state unavailable")
            .entry(request_id)
            .or_insert(None);
    }

    pub(super) fn answer(&self, request_id: &str) -> Option<ConfirmationAnswer> {
        self.confirmations
            .lock()
            .expect("tool confirmation state unavailable")
            .get(request_id)
            .and_then(Clone::clone)
    }

    pub(super) fn contains_request(&self, request_id: &str) -> bool {
        self.confirmations
            .lock()
            .expect("tool confirmation state unavailable")
            .contains_key(request_id)
    }

    pub(super) fn record_answer(&self, request_id: &str, answer: ConfirmationAnswer) -> Result<()> {
        let mut confirmations = self
            .confirmations
            .lock()
            .expect("tool confirmation state unavailable");
        match confirmations.get_mut(request_id) {
            None => return Err(anyhow!("tool confirmation request is no longer active")),
            Some(Some(_)) => return Err(anyhow!("tool confirmation request was already answered")),
            Some(slot @ None) => *slot = Some(answer),
        }
        drop(confirmations);
        self.confirmation_answered.notify_waiters();
        Ok(())
    }

    /// Waits until every pending request is answered.
    ///
    /// Returns `true` when a state-machine answer arrived (the turn resumes) and
    /// `false` when there is nothing to resume. `timeout` bounds the wait: a
    /// confirmation nobody answers used to park the session forever, because the
    /// turn lock is held for the whole stream. On expiry every pending request is
    /// answered with `Cancel` so the caller can finish the turn instead of hanging.
    pub(super) async fn wait_for_all_confirmation_answers(
        &self,
        cancel: &CancellationToken,
        timeout: Option<Duration>,
    ) -> bool {
        loop {
            let answer_received = self.confirmation_answered.notified();
            tokio::pin!(answer_received);
            answer_received.as_mut().enable();

            let completed = {
                let confirmations = self
                    .confirmations
                    .lock()
                    .expect("tool confirmation state unavailable");
                (!confirmations.is_empty() && confirmations.values().all(Option::is_some)).then(
                    || {
                        confirmations.values().any(|answer| {
                            matches!(answer, Some(ConfirmationAnswer::StateMachine(_)))
                        })
                    },
                )
            };
            if let Some(has_state_machine_answer) = completed {
                return has_state_machine_answer;
            }

            tokio::select! {
                _ = answer_received => {}
                _ = cancel.cancelled() => return true,
                _ = wait_timeout(timeout) => {
                    let pending = self.pending_request_ids();
                    if self.expire_pending() {
                        warn!(
                            pending = pending.len(),
                            "Tool confirmation expired without an answer; the pending tools were denied"
                        );
                    }
                    return false;
                }
            }
        }
    }

    /// Denies every unanswered request. Returns `true` when something was pending.
    fn expire_pending(&self) -> bool {
        let mut confirmations = self
            .confirmations
            .lock()
            .expect("tool confirmation state unavailable");
        let mut expired = false;
        for slot in confirmations.values_mut() {
            if slot.is_none() {
                *slot = Some(ConfirmationAnswer::StateMachine(Permission::Cancel));
                expired = true;
            }
        }
        drop(confirmations);
        if expired {
            self.confirmation_answered.notify_waiters();
        }
        expired
    }

    pub(super) fn clear_confirmations(&self) {
        self.confirmations
            .lock()
            .expect("tool confirmation state unavailable")
            .clear();
    }

    pub(super) fn pending_request_ids(&self) -> Vec<String> {
        self.confirmations
            .lock()
            .expect("tool confirmation state unavailable")
            .iter()
            .filter(|(_, answer)| answer.is_none())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub(super) fn extension_lease(&self) -> Arc<StdMutex<Option<Arc<ExtensionLease>>>> {
        Arc::clone(&self.extension_lease)
    }

    pub(super) fn start_new_turn(&self) {
        self.clear_confirmations();
        self.clear_extension_lease();
    }

    fn has_confirmations(&self) -> bool {
        !self
            .confirmations
            .lock()
            .expect("tool confirmation state unavailable")
            .is_empty()
    }

    pub(super) fn clear_extension_lease(&self) {
        *self
            .extension_lease
            .lock()
            .expect("extension lease unavailable") = None;
    }
}

pub(super) struct ActiveTurnGuard {
    state: Arc<SessionToolConfirmationState>,
    _turn_lock_guard: OwnedMutexGuard<()>,
}

impl ActiveTurnGuard {
    pub(super) fn state(&self) -> &Arc<SessionToolConfirmationState> {
        &self.state
    }
}

impl Drop for ActiveTurnGuard {
    fn drop(&mut self) {
        if !self.state.has_confirmations() {
            self.state.clear_extension_lease();
        }
    }
}

pub(super) struct ToolConfirmationCoordinator {
    sessions: StdMutex<HashMap<String, Arc<SessionToolConfirmationState>>>,
}

impl ToolConfirmationCoordinator {
    pub(super) fn new() -> Self {
        Self {
            sessions: StdMutex::new(HashMap::new()),
        }
    }

    pub(super) fn session(&self, session_id: &str) -> Arc<SessionToolConfirmationState> {
        self.sessions
            .lock()
            .expect("tool confirmation coordinator unavailable")
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(SessionToolConfirmationState::new()))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn confirmation_timeout_releases_the_turn_and_denies_pending_tools() {
        let session = SessionToolConfirmationState::new();
        session.register_request("request-1".into());

        let resumed = session
            .wait_for_all_confirmation_answers(
                &CancellationToken::new(),
                Some(std::time::Duration::from_millis(20)),
            )
            .await;

        assert!(
            !resumed,
            "sin respuesta del operador no hay nada que reanudar en el state machine"
        );
        assert_eq!(
            session.answer("request-1"),
            Some(ConfirmationAnswer::StateMachine(Permission::Cancel)),
            "la tool pendiente queda denegada, no aprobada"
        );
        assert!(session.pending_request_ids().is_empty());
    }

    #[tokio::test]
    async fn confirmation_without_timeout_still_resumes_on_answer() {
        let session = SessionToolConfirmationState::new();
        session.register_request("request-1".into());
        let cancel = CancellationToken::new();
        let (resumed, ()) = tokio::join!(
            session.wait_for_all_confirmation_answers(&cancel, None),
            async {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                session
                    .record_answer(
                        "request-1",
                        ConfirmationAnswer::StateMachine(Permission::AllowOnce),
                    )
                    .unwrap();
            }
        );
        assert!(resumed, "una respuesta del operador reanuda el turno");
    }

    #[test]
    fn rejects_a_second_active_turn_and_releases_on_drop() {
        let coordinator = ToolConfirmationCoordinator::new();
        let session = coordinator.session("session");
        let guard = session.try_start_turn().unwrap();

        assert!(session.try_start_turn().is_err());

        drop(guard);
        assert!(session.try_start_turn().is_ok());
    }

    #[tokio::test]
    async fn waits_for_every_confirmation_in_the_batch() {
        let coordinator = ToolConfirmationCoordinator::new();
        let session = coordinator.session("session");
        let _guard = session.try_start_turn().unwrap();
        session.register_request("request-1".to_string());
        session.register_request("request-2".to_string());
        session
            .record_answer(
                "request-1",
                ConfirmationAnswer::StateMachine(Permission::AllowOnce),
            )
            .unwrap();
        session
            .record_answer("request-2", ConfirmationAnswer::LiveHandled)
            .unwrap();

        let has_state_machine_answer = session
            .wait_for_all_confirmation_answers(&CancellationToken::new(), None)
            .await;

        assert!(has_state_machine_answer);
    }

    #[test]
    fn interrupted_turn_keeps_pending_requests_until_the_next_turn() {
        let coordinator = ToolConfirmationCoordinator::new();
        let session = coordinator.session("session");
        let guard = session.try_start_turn().unwrap();
        session.register_request("request".to_string());
        assert!(session.contains_request("request"));

        drop(guard);

        assert!(session.contains_request("request"));
        let next_turn = session.try_start_turn().unwrap();
        session.start_new_turn();
        assert!(!session.contains_request("request"));
        assert!(session.answer("request").is_none());
        drop(next_turn);
    }

    #[test]
    fn first_answer_is_immutable() {
        let coordinator = ToolConfirmationCoordinator::new();
        let session = coordinator.session("session");
        let _guard = session.try_start_turn().unwrap();
        session.register_request("request".to_string());
        session
            .record_answer(
                "request",
                ConfirmationAnswer::StateMachine(Permission::AllowOnce),
            )
            .unwrap();

        assert!(session
            .record_answer(
                "request",
                ConfirmationAnswer::StateMachine(Permission::DenyOnce),
            )
            .is_err());
        assert_eq!(
            session.answer("request"),
            Some(ConfirmationAnswer::StateMachine(Permission::AllowOnce))
        );
    }
}
