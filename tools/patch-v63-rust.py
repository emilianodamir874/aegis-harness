import io, sys

CRLF = chr(13) + chr(10)
LF = chr(10)

def patch(path, edits, label):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        src = f.read()
    for i, pair in enumerate(edits):
        old, new = pair
        o = old.replace(LF, CRLF)
        n = new.replace(LF, CRLF)
        c = src.count(o)
        if c != 1:
            print('FAIL %s edit#%d count=%d' % (label, i, c))
            print(o[:200])
            sys.exit(1)
        src = src.replace(o, n)
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(src)
    print('OK %s (%d edits)' % (label, len(edits)))

AR = 'C:/goose/crates/goose/src/execution/active_run.rs'
SV = 'C:/goose/crates/goose/src/acp/server.rs'

ar_edits = []

ar_edits.append(('''use crate::agents::Agent;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;''', '''use crate::agents::Agent;
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
}'''))

ar_edits.append(('''struct ActiveRun {
    run_id: String,
    cancel_token: CancellationToken,
    /// Routes steering from another roaming connection to the run owner.
    agent: Arc<Agent>,
}''', '''struct ActiveRun {
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
}'''))

ar_edits.append(('''            SessionRunState {
                agent_run: Some(ActiveRun {
                    run_id,
                    cancel_token,
                    agent,
                }),
                live_active: false,
            },''', '''            SessionRunState {
                agent_run: Some(ActiveRun::new(run_id, cancel_token, agent)),
                live_active: false,
            },'''))

ar_edits.append(('''        state.agent_run = Some(ActiveRun {
            run_id,
            cancel_token,
            agent,
        });''', '''        state.agent_run = Some(ActiveRun::new(run_id, cancel_token, agent));'''))

ar_edits.append(('''    pub(crate) fn is_active(&self, session_id: &str) -> bool {''', '''    /// Records progress for the session's active run. Called on every event the
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

    pub(crate) fn is_active(&self, session_id: &str) -> bool {'''))

sv_edits = []

sv_edits.append((
    '    ConfigOptionUpdate, ContentBlock, Cost, CurrentModeUpdate, DeleteSessionRequest,',
    '    ConfigOptionUpdate, ContentBlock, ContentChunk, Cost, CurrentModeUpdate, DeleteSessionRequest,'))

sv_edits.append(('''        while let Some(event) = stream.next().await {
            if cancel_token.is_cancelled() {
                continue;
            }''', '''        while let Some(event) = stream.next().await {
            self.active_runs.touch_progress(session_id);

            if cancel_token.is_cancelled() {
                continue;
            }'''))

sv_edits.append(('''        let _run_guard = ActiveRunDropGuard {
            registry: self.active_runs.clone(),
            session_id: session_id.clone(),
            run_id: run_id.clone(),
            cancel_token: cancel_token.clone(),
        };''', '''        let _run_guard = ActiveRunDropGuard {
            registry: self.active_runs.clone(),
            session_id: session_id.clone(),
            run_id: run_id.clone(),
            cancel_token: cancel_token.clone(),
        };

        // Stall watchdog: a run that stops making progress (provider hang, a
        // dropped tool result) used to die silently, leaving the client mute
        // and tool cards spinning. This closes it with a visible error.
        spawn_run_watchdog(
            self.active_runs.clone(),
            cx.clone(),
            session_id.clone(),
            run_id.clone(),
            cancel_token.clone(),
        );'''))

sv_edits.append(('''        let session_id = args.session_id.0.to_string();
        let token = self.active_runs.agent_cancel_token(&session_id);''', '''        let session_id = args.session_id.0.to_string();
        self.active_runs.mark_client_cancelled(&session_id);
        let token = self.active_runs.agent_cancel_token(&session_id);'''))

sv_edits.append(('''        self.clear_active_run(&session_id, &run_id).await;
        Self::send_active_run_update(cx, &args.session_id, None)?;
        let outcome = stream_result?;''', '''        // Read the run flags before clearing the registry entry: a cancellation
        // nobody asked for (a lost connection, an internal cancel) used to end
        // the turn with no error at all, leaving the UI mute.
        let was_stalled = self.active_runs.was_stalled(&session_id, &run_id);
        let client_cancelled = self
            .active_runs
            .was_client_cancelled(&session_id, &run_id)
            .unwrap_or(true);
        self.clear_active_run(&session_id, &run_id).await;
        Self::send_active_run_update(cx, &args.session_id, None)?;
        let outcome = stream_result?;
        if outcome.was_cancelled && !was_stalled && !client_cancelled {
            let text = "El turno se interrumpio de forma inesperada (no lo pediste). El run se cerro y las herramientas en curso pueden haber quedado sin resultado.";
            let chunk = ContentChunk::new(ContentBlock::Text(TextContent::new(text)));
            let _ = cx.send_notification(SessionNotification::new(
                args.session_id.clone(),
                SessionUpdate::AgentMessageChunk(chunk),
            ));
        }'''))

sv_edits.append(('''fn prompt_stop_reason(was_cancelled: bool, output_token_limit_reached: bool) -> StopReason {''', '''/// Stall watchdog timeout. GOOSE_RUN_STALL_TIMEOUT_SECS (default 900, 0 disables).
fn run_watchdog_stall_timeout() -> Option<std::time::Duration> {
    let secs = Config::global()
        .get_param::<u64>("GOOSE_RUN_STALL_TIMEOUT_SECS")
        .unwrap_or(900);
    if secs == 0 {
        None
    } else {
        Some(std::time::Duration::from_secs(secs))
    }
}

/// How often the watchdog samples progress. GOOSE_RUN_WATCHDOG_POLL_SECS (default 30).
fn run_watchdog_poll_interval() -> std::time::Duration {
    let secs = Config::global()
        .get_param::<u64>("GOOSE_RUN_WATCHDOG_POLL_SECS")
        .unwrap_or(30);
    std::time::Duration::from_secs(secs.max(5))
}

/// Closes a run that stopped making progress, with an error the client can see.
fn spawn_run_watchdog(
    registry: Arc<ActiveRunRegistry>,
    cx: ConnectionTo<Client>,
    session_id: String,
    run_id: String,
    cancel_token: CancellationToken,
) {
    let Some(stall) = run_watchdog_stall_timeout() else {
        return;
    };
    let poll = run_watchdog_poll_interval();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(poll).await;
            let Some(age) = registry.progress_age_secs(&session_id, &run_id) else {
                // The run finished (or was replaced): stop watching.
                return;
            };
            if age < stall.as_secs() {
                continue;
            }
            warn!(
                session_id = %session_id,
                run_id = %run_id,
                stalled_secs = age,
                "closing stalled run: no progress within the watchdog window"
            );
            registry.mark_stalled(&session_id, &run_id);
            let acp_session = SessionId::new(session_id.clone());
            let minutes = (stall.as_secs() / 60).max(1);
            let text = format!(
                "El turno se cerro automaticamente: {} minuto(s) sin ningun avance del proveedor. Se cancelo el run; las herramientas en curso quedaron sin resultado.",
                minutes
            );
            let chunk = ContentChunk::new(ContentBlock::Text(TextContent::new(text)));
            let _ = cx.send_notification(SessionNotification::new(
                acp_session.clone(),
                SessionUpdate::AgentMessageChunk(chunk),
            ));
            let _ = GooseAcpAgent::send_active_run_update(&cx, &acp_session, None);
            registry.cancel_agent_run(&session_id);
            cancel_token.cancel();
            return;
        }
    });
}

fn prompt_stop_reason(was_cancelled: bool, output_token_limit_reached: bool) -> StopReason {'''))

patch(AR, ar_edits, 'active_run.rs')
patch(SV, sv_edits, 'server.rs')
