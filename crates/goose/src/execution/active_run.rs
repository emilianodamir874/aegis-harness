use crate::agents::Agent;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct ActiveRun {
    run_id: String,
    cancel_token: CancellationToken,
    /// Routes steering from another roaming connection to the run owner.
    agent: Arc<Agent>,
    /// Epoch millis of the last observed progress (stream event, tool call,
    /// tool result). The stall watchdog compares this against the configured
    /// timeout so a run that stops advancing is closed with a visible error.
    last_progress_ms: Arc<AtomicU64>,
    /// Set by the watchdog when it closed the run for lack of progress.
    stalled: Arc<AtomicBool>,
    /// Set when the client itself asked to cancel, so a normal stop is not
    /// later reported as an unexpected interruption.
    client_cancelled: Arc<AtomicBool>,
}

impl ActiveRun {
    fn new(run_id: String, cancel_token: CancellationToken, agent: Arc<Agent>) -> Self {
        Self {
            run_id,
            cancel_token,
            agent,
            last_progress_ms: Arc::new(AtomicU64::new(now_millis())),
            stalled: Arc::new(AtomicBool::new(false)),
            client_cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct SessionRunState {
    agent_run: Option<ActiveRun>,
    live_active: bool,
}

pub(crate) enum StartRunError {
    AgentRunExists { run_id: String },
    LiveVoiceInteractionExists,
    LiveVoiceInteractionMissing,
}

#[derive(Default)]
pub struct ActiveRunRegistry {
    runs_by_session: Mutex<HashMap<String, SessionRunState>>,
}

impl ActiveRunRegistry {
    pub(crate) fn start_prompt_run(
        &self,
        session_id: &str,
        run_id: String,
        cancel_token: CancellationToken,
        agent: Arc<Agent>,
    ) -> Result<(), StartRunError> {
        let mut runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        if let Some(state) = runs.get(session_id) {
            if let Some(agent_run) = &state.agent_run {
                return Err(StartRunError::AgentRunExists {
                    run_id: agent_run.run_id.clone(),
                });
            }
            if state.live_active {
                return Err(StartRunError::LiveVoiceInteractionExists);
            }
        }
        runs.insert(
            session_id.to_string(),
            SessionRunState {
                agent_run: Some(ActiveRun::new(run_id, cancel_token, agent)),
                live_active: false,
            },
        );
        Ok(())
    }

    pub(crate) fn start_live_delegation(
        &self,
        session_id: &str,
        run_id: String,
        cancel_token: CancellationToken,
        agent: Arc<Agent>,
    ) -> Result<(), StartRunError> {
        let mut runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        let Some(state) = runs.get_mut(session_id) else {
            return Err(StartRunError::LiveVoiceInteractionMissing);
        };
        if let Some(agent_run) = &state.agent_run {
            return Err(StartRunError::AgentRunExists {
                run_id: agent_run.run_id.clone(),
            });
        }
        state.agent_run = Some(ActiveRun::new(run_id, cancel_token, agent));
        Ok(())
    }

    pub(crate) fn agent_run(&self, session_id: &str) -> Option<(String, Arc<Agent>)> {
        self.runs_by_session
            .lock()
            .expect("active run lock poisoned")
            .get(session_id)
            .and_then(|state| state.agent_run.as_ref())
            .map(|run| (run.run_id.clone(), run.agent.clone()))
    }

    pub(crate) fn agent_cancel_token(&self, session_id: &str) -> Option<CancellationToken> {
        self.runs_by_session
            .lock()
            .expect("active run lock poisoned")
            .get(session_id)
            .and_then(|state| state.agent_run.as_ref())
            .map(|run| run.cancel_token.clone())
    }

    pub(crate) fn cancel_agent_run(&self, session_id: &str) {
        if let Some(cancel_token) = self.agent_cancel_token(session_id) {
            cancel_token.cancel();
        }
    }

    pub(crate) fn remove_agent_run(&self, session_id: &str, run_id: &str) -> Option<Arc<Agent>> {
        let mut runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        let state = runs.get_mut(session_id)?;
        if state.agent_run.as_ref()?.run_id != run_id {
            return None;
        }
        let agent = state.agent_run.take()?.agent;
        if !state.live_active {
            runs.remove(session_id);
        }
        Some(agent)
    }

    pub(crate) fn start_live(&self, session_id: &str) -> bool {
        let mut runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        if runs.contains_key(session_id) {
            return false;
        }
        runs.insert(
            session_id.to_string(),
            SessionRunState {
                agent_run: None,
                live_active: true,
            },
        );
        true
    }

    pub(crate) fn finish_live(&self, session_id: &str) {
        let mut runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        if let Some(state) = runs.get_mut(session_id) {
            state.live_active = false;
            if state.agent_run.is_none() {
                runs.remove(session_id);
            }
        }
    }

    /// Records progress for the session's active run. Called on every event the
    /// ACP server forwards (message chunks, tool calls, tool results), so the
    /// stall watchdog only fires when nothing at all is happening.
    pub(crate) fn touch_progress(&self, session_id: &str) {
        let runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        if let Some(run) = runs.get(session_id).and_then(|state| state.agent_run.as_ref()) {
            run.last_progress_ms.store(now_millis(), Ordering::Relaxed);
        }
    }

    /// Seconds since the given run last made progress. None once the run is
    /// gone (finished or replaced), which also stops the watchdog.
    pub(crate) fn progress_age_secs(&self, session_id: &str, run_id: &str) -> Option<u64> {
        let runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        let run = runs.get(session_id)?.agent_run.as_ref()?;
        if run.run_id != run_id {
            return None;
        }
        let last = run.last_progress_ms.load(Ordering::Relaxed);
        Some(now_millis().saturating_sub(last) / 1000)
    }

    pub(crate) fn mark_stalled(&self, session_id: &str, run_id: &str) {
        let runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        if let Some(run) = runs.get(session_id).and_then(|state| state.agent_run.as_ref()) {
            if run.run_id == run_id {
                run.stalled.store(true, Ordering::Relaxed);
            }
        }
    }

    pub(crate) fn was_stalled(&self, session_id: &str, run_id: &str) -> bool {
        let runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        runs.get(session_id)
            .and_then(|state| state.agent_run.as_ref())
            .filter(|run| run.run_id == run_id)
            .map(|run| run.stalled.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    pub(crate) fn mark_client_cancelled(&self, session_id: &str) {
        let runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        if let Some(run) = runs.get(session_id).and_then(|state| state.agent_run.as_ref()) {
            run.client_cancelled.store(true, Ordering::Relaxed);
        }
    }

    /// Some(true)/Some(false) for the live run; None when it is gone.
    pub(crate) fn was_client_cancelled(&self, session_id: &str, run_id: &str) -> Option<bool> {
        let runs = self
            .runs_by_session
            .lock()
            .expect("active run lock poisoned");
        let run = runs.get(session_id)?.agent_run.as_ref()?;
        if run.run_id != run_id {
            return None;
        }
        Some(run.client_cancelled.load(Ordering::Relaxed))
    }

    pub(crate) fn is_active(&self, session_id: &str) -> bool {
        self.runs_by_session
            .lock()
            .expect("active run lock poisoned")
            .contains_key(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_runs_are_scoped_by_session() {
        let registry = ActiveRunRegistry::default();

        assert!(registry.start_live("one"));
        assert!(!registry.start_live("one"));
        assert!(registry.start_live("two"));

        registry.finish_live("one");
        assert!(registry.start_live("one"));
    }

    #[tokio::test]
    async fn prompt_and_live_runs_conflict() {
        let registry = ActiveRunRegistry::default();

        assert!(registry
            .start_prompt_run(
                "session",
                "run".into(),
                CancellationToken::new(),
                Arc::new(Agent::new()),
            )
            .is_ok());
        assert!(!registry.start_live("session"));

        registry.remove_agent_run("session", "run");
        assert!(registry.start_live("session"));
        assert!(matches!(
            registry.start_prompt_run(
                "session",
                "run".into(),
                CancellationToken::new(),
                Arc::new(Agent::new()),
            ),
            Err(StartRunError::LiveVoiceInteractionExists)
        ));
    }

    #[tokio::test]
    async fn live_delegation_shares_the_live_session_without_admitting_another_prompt() {
        let registry = ActiveRunRegistry::default();
        assert!(registry.start_live("session"));
        assert!(registry
            .start_live_delegation(
                "session",
                "delegated".into(),
                CancellationToken::new(),
                Arc::new(Agent::new()),
            )
            .is_ok());
        assert!(matches!(
            registry.start_prompt_run(
                "session",
                "prompt".into(),
                CancellationToken::new(),
                Arc::new(Agent::new()),
            ),
            Err(StartRunError::AgentRunExists { .. })
        ));

        registry.finish_live("session");
        assert_eq!(
            registry.agent_run("session").map(|(run_id, _)| run_id),
            Some("delegated".into())
        );
    }
}
