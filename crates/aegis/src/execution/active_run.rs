use crate::agents::Agent;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::Error as AcpError;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
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

type PromptResult = Result<PromptResponse, AcpError>;
const PROMPT_CACHE_TTL: Duration = Duration::from_secs(600);
const PROMPT_CACHE_LIMIT: usize = 1024;

enum PromptEntryState {
    Running(watch::Sender<Option<PromptResult>>),
    Completed {
        result: Box<PromptResult>,
        at: Instant,
    },
}

struct PromptEntry {
    digest: blake3::Hash,
    generation: u64,
    state: PromptEntryState,
}

pub(crate) enum PromptClaim {
    Owner(PromptLease),
    Waiting(watch::Receiver<Option<PromptResult>>),
    Completed(PromptResult),
}

pub(crate) struct PromptLease {
    registry: Arc<ActiveRunRegistry>,
    key: (String, String),
    generation: u64,
    finished: bool,
}

impl PromptLease {
    pub(crate) fn finish(mut self, result: &PromptResult) {
        self.registry
            .finish_prompt(&self.key, self.generation, result, result.is_ok());
        self.finished = true;
    }
}

impl Drop for PromptLease {
    fn drop(&mut self) {
        if !self.finished {
            self.registry.finish_prompt(
                &self.key,
                self.generation,
                &Err(AcpError::internal_error().data("Prompt task terminated unexpectedly")),
                false,
            );
        }
    }
}

impl PromptClaim {
    pub(crate) fn is_owner(&self) -> bool {
        matches!(self, Self::Owner(_))
    }

    pub(crate) fn finish(self, result: &PromptResult) {
        if let Self::Owner(lease) = self {
            lease.finish(result);
        }
    }

    pub(crate) async fn response(self) -> PromptResult {
        match self {
            Self::Completed(result) => result,
            Self::Waiting(mut receiver) => loop {
                if let Some(result) = receiver.borrow_and_update().clone() {
                    return result;
                }
                if receiver.changed().await.is_err() {
                    return Err(
                        AcpError::internal_error().data("Prompt task terminated unexpectedly")
                    );
                }
            },
            Self::Owner(_) => unreachable!("owner must execute the prompt"),
        }
    }
}

#[derive(Default)]
pub struct ActiveRunRegistry {
    runs_by_session: Mutex<HashMap<String, SessionRunState>>,
    prompts: Mutex<HashMap<(String, String), PromptEntry>>,
    next_prompt_generation: AtomicU64,
}

impl ActiveRunRegistry {
    pub(crate) fn claim_prompt(
        self: &Arc<Self>,
        session_id: &str,
        prompt_id: &str,
        digest: blake3::Hash,
    ) -> Result<PromptClaim, AcpError> {
        let mut prompts = self.prompts.lock().expect("prompt registry lock poisoned");
        let now = Instant::now();
        prompts.retain(|_, entry| match &entry.state {
            PromptEntryState::Completed { at, .. } => now.duration_since(*at) < PROMPT_CACHE_TTL,
            PromptEntryState::Running(_) => true,
        });
        let key = (session_id.to_string(), prompt_id.to_string());
        if let Some(entry) = prompts.get(&key) {
            if entry.digest != digest {
                return Err(
                    AcpError::invalid_params().data("promptId already used for different content")
                );
            }
            return Ok(match &entry.state {
                PromptEntryState::Running(sender) => PromptClaim::Waiting(sender.subscribe()),
                PromptEntryState::Completed { result, .. } => {
                    PromptClaim::Completed((**result).clone())
                }
            });
        }
        if prompts.len() >= PROMPT_CACHE_LIMIT {
            let oldest = prompts
                .iter()
                .filter_map(|(key, entry)| match &entry.state {
                    PromptEntryState::Completed { at, .. } => Some((key.clone(), *at)),
                    PromptEntryState::Running(_) => None,
                })
                .min_by_key(|(_, at)| *at);
            if let Some((oldest, _)) = oldest {
                prompts.remove(&oldest);
            } else {
                return Err(AcpError::internal_error().data("Too many in-flight prompts"));
            }
        }
        let (sender, _) = watch::channel(None);
        let generation = self.next_prompt_generation.fetch_add(1, Ordering::Relaxed);
        prompts.insert(
            key.clone(),
            PromptEntry {
                digest,
                generation,
                state: PromptEntryState::Running(sender),
            },
        );
        Ok(PromptClaim::Owner(PromptLease {
            registry: Arc::clone(self),
            key,
            generation,
            finished: false,
        }))
    }

    fn finish_prompt(
        &self,
        key: &(String, String),
        generation: u64,
        result: &PromptResult,
        cache: bool,
    ) {
        let mut prompts = self.prompts.lock().expect("prompt registry lock poisoned");
        if let Some(entry) = prompts.get_mut(key) {
            if entry.generation != generation {
                return;
            }
            if let PromptEntryState::Running(sender) = &entry.state {
                sender.send_replace(Some(result.clone()));
                if cache {
                    entry.state = PromptEntryState::Completed {
                        result: Box::new(result.clone()),
                        at: Instant::now(),
                    };
                } else {
                    prompts.remove(key);
                }
            }
        }
    }

    pub(crate) fn clear_session_prompts(&self, session_id: &str) {
        let mut prompts = self.prompts.lock().expect("prompt registry lock poisoned");
        prompts.retain(|(session, _), entry| {
            if session != session_id {
                return true;
            }
            if let PromptEntryState::Running(sender) = &entry.state {
                sender.send_replace(Some(Err(AcpError::invalid_params().data("Session closed"))));
            }
            false
        });
    }

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
        if let Some(run) = runs
            .get(session_id)
            .and_then(|state| state.agent_run.as_ref())
        {
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
        if let Some(run) = runs
            .get(session_id)
            .and_then(|state| state.agent_run.as_ref())
        {
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
        if let Some(run) = runs
            .get(session_id)
            .and_then(|state| state.agent_run.as_ref())
        {
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
    #[tokio::test]
    async fn identical_prompts_share_running_and_completed_response() {
        let registry = Arc::new(ActiveRunRegistry::default());
        let digest = blake3::hash(b"content");
        let owner = registry.claim_prompt("one", "id", digest).unwrap();
        assert!(owner.is_owner());
        let waiter = registry.claim_prompt("one", "id", digest).unwrap();
        let response = PromptResponse::new(agent_client_protocol::schema::v1::StopReason::EndTurn);
        owner.finish(&Ok(response.clone()));
        assert_eq!(waiter.response().await.unwrap(), response);
        assert_eq!(
            registry
                .claim_prompt("one", "id", digest)
                .unwrap()
                .response()
                .await
                .unwrap(),
            response
        );
        assert!(registry
            .claim_prompt("two", "id", digest)
            .unwrap()
            .is_owner());
    }

    #[tokio::test]
    async fn rejects_reused_id_for_different_prompt() {
        let registry = Arc::new(ActiveRunRegistry::default());
        let _owner = registry
            .claim_prompt("session", "id", blake3::hash(b"a"))
            .unwrap();
        assert!(registry
            .claim_prompt("session", "id", blake3::hash(b"b"))
            .is_err());
    }

    #[tokio::test]
    async fn failure_and_drop_release_id_and_wake_waiters() {
        let registry = Arc::new(ActiveRunRegistry::default());
        let digest = blake3::hash(b"a");
        let owner = registry.claim_prompt("session", "id", digest).unwrap();
        let waiter = registry.claim_prompt("session", "id", digest).unwrap();
        drop(owner);
        assert!(waiter.response().await.is_err());
        let owner = registry.claim_prompt("session", "id", digest).unwrap();
        assert!(owner.is_owner());
        let waiter = registry.claim_prompt("session", "id", digest).unwrap();
        owner.finish(&Err(AcpError::invalid_params()));
        assert!(waiter.response().await.is_err());
        let retry = registry.claim_prompt("session", "id", digest).unwrap();
        assert!(retry.is_owner());
        retry.finish(&Ok(PromptResponse::new(
            agent_client_protocol::schema::v1::StopReason::EndTurn,
        )));
    }

    #[tokio::test]
    async fn clearing_session_does_not_allow_old_owner_to_overwrite_reused_id() {
        let registry = Arc::new(ActiveRunRegistry::default());
        let digest = blake3::hash(b"a");
        let owner = registry.claim_prompt("session", "id", digest).unwrap();
        let waiter = registry.claim_prompt("session", "id", digest).unwrap();
        registry.clear_session_prompts("session");
        assert!(waiter.response().await.is_err());
        let replacement = registry.claim_prompt("session", "id", digest).unwrap();
        owner.finish(&Ok(PromptResponse::new(
            agent_client_protocol::schema::v1::StopReason::EndTurn,
        )));
        assert!(!registry
            .claim_prompt("session", "id", digest)
            .unwrap()
            .is_owner());
        replacement.finish(&Ok(PromptResponse::new(
            agent_client_protocol::schema::v1::StopReason::Cancelled,
        )));
        assert_eq!(
            registry
                .claim_prompt("session", "id", digest)
                .unwrap()
                .response()
                .await
                .unwrap()
                .stop_reason,
            agent_client_protocol::schema::v1::StopReason::Cancelled
        );
    }

    #[test]
    fn cache_expires_and_evicts_oldest_completed() {
        let registry = Arc::new(ActiveRunRegistry::default());
        let digest = blake3::hash(b"a");
        registry
            .claim_prompt("session", "expired", digest)
            .unwrap()
            .finish(&Ok(PromptResponse::new(
                agent_client_protocol::schema::v1::StopReason::EndTurn,
            )));
        let mut prompts = registry.prompts.lock().unwrap();
        let entry = prompts
            .get_mut(&(String::from("session"), String::from("expired")))
            .unwrap();
        entry.state = PromptEntryState::Completed {
            result: Box::new(Ok(PromptResponse::new(
                agent_client_protocol::schema::v1::StopReason::EndTurn,
            ))),
            at: Instant::now() - PROMPT_CACHE_TTL,
        };
        drop(prompts);
        assert!(registry
            .claim_prompt("session", "expired", digest)
            .unwrap()
            .is_owner());
    }
}
