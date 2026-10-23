//! Per-session fan-out of session events for ACP connections (v6.4).
//!
//! The ACP transport has no fan-out: one mailbox has one active subscriber, so
//! a turn's `session/update` stream only ever reached the connection that
//! called `session/prompt`. This hub turns a session into the unit of
//! streaming: every connection can register as a watcher of a session and
//! receives the same notifications, live and (on join) replayed by cursor.
//!
//! Design constraints that shaped this module:
//!
//! * The hub never stores `ConnectionTo<Client>` of another connection. It
//!   stores per-watcher `mpsc` senders only; each connection owns a forwarder
//!   task that drains its receiver and writes to its own connection. When the
//!   connection dies its receiver is dropped, the send fails, and the watcher
//!   is pruned. No leaks, no reference cycles.
//! * `publish` never awaits and never blocks: the lock is a plain
//!   `std::sync::Mutex` held only for map/queue operations plus non-blocking
//!   bounded-channel sends. A lagging watcher is removed and receives a terminal
//!   `replay_gap` after queued frames. It cannot stall the agent stream.
//! * A bounded ring buffer per session (500 events / 2 MB) lets a late or
//!   reconnecting watcher catch up. When the ring dropped events the watcher
//!   is told with `replay_gap` and must do a full `session/load`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use agent_client_protocol::{Client, ConnectionTo, JsonRpcNotification, UntypedMessage};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::execution::ActiveRunRegistry;

/// Maximum events kept per session ring buffer.
pub(crate) const MAX_EVENTS: usize = 500;
/// Maximum bytes kept per session ring buffer.
pub(crate) const MAX_BYTES: usize = 2 * 1024 * 1024;
/// Idle sessions (no watchers, no active run) release their ring after this.
const SESSION_TTL: Duration = Duration::from_secs(600);
const REAP_INTERVAL: Duration = Duration::from_secs(60);
/// Frames awaiting one watcher forwarder; a full queue terminates the watch.
const WATCHER_QUEUE_FRAMES: usize = 64;

pub(crate) const REPLAY_GAP_METHOD: &str = "_aegis/unstable/session/replay_gap";

/// What a published event means for replay bookkeeping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventKind {
    Normal,
    /// `activeRunId` became `Some(run)`: a late watcher with `since: null`
    /// replays from here.
    RunStart,
    /// `activeRunId` became `None`; the terminal state is replayed too.
    RunEnd,
}

struct RingEntry {
    cursor: u64,
    json: Arc<String>,
}

struct SessionLog {
    epoch: String,
    entries: VecDeque<RingEntry>,
    bytes: usize,
    next_cursor: u64,
    /// Cursor a `since: null` watcher should start from (the current or last
    /// run boundary); `None` means "from now".
    replay_from: Option<u64>,
    active_run_id: Option<String>,
}

impl Default for SessionLog {
    fn default() -> Self {
        Self {
            epoch: Uuid::new_v4().to_string(),
            entries: VecDeque::new(),
            bytes: 0,
            next_cursor: 0,
            replay_from: None,
            active_run_id: None,
        }
    }
}

impl SessionLog {
    fn current_cursor(&self) -> u64 {
        self.next_cursor
    }

    fn oldest_cursor(&self) -> u64 {
        self.entries
            .front()
            .map(|entry| entry.cursor)
            .unwrap_or_else(|| self.next_cursor.saturating_add(1))
    }

    fn push(&mut self, method: &str, mut params: Value, kind: EventKind) -> Option<String> {
        let run_id = if kind == EventKind::RunStart {
            params
                .pointer("/update/_meta/aegis/activeRunId")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        };
        let cursor = self.next_cursor.checked_add(1)?;
        let aegis = params
            .as_object_mut()
            .and_then(|params| {
                params
                    .entry("_meta")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
            })
            .and_then(|meta| {
                meta.entry("aegis")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
            });
        if let Some(aegis) = aegis {
            aegis.insert("cursor".into(), json!(cursor));
        }
        let json = serde_json::to_string(&UntypedMessage::new(method, params).ok()?).ok()?;
        self.next_cursor = cursor;
        self.bytes += json.len();
        self.entries.push_back(RingEntry {
            cursor,
            json: Arc::new(json.clone()),
        });
        match kind {
            EventKind::RunStart | EventKind::RunEnd => {
                self.replay_from = Some(cursor);
                self.active_run_id = run_id;
            }
            EventKind::Normal => {}
        }
        while self.entries.len() > MAX_EVENTS || self.bytes > MAX_BYTES {
            let Some(dropped) = self.entries.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(dropped.json.len());
        }
        Some(json)
    }

    /// Returns the replay payload (`{"method":..,"params":..}` notifications)
    /// and whether events between the requested cursor and the ring were lost.
    fn replay(&self, since: Option<u64>) -> (Vec<Value>, bool) {
        let current = self.current_cursor();
        let from = match since {
            Some(since) => since.min(current),
            None => self
                .replay_from
                .map(|cursor| cursor.saturating_sub(1))
                .unwrap_or(current),
        };
        let gap = since.is_some_and(|since| since > current)
            || from.saturating_add(1) < self.oldest_cursor();
        let items = self
            .entries
            .iter()
            .filter(|entry| entry.cursor > from)
            .map(|entry| serde_json::from_str::<Value>(&entry.json).unwrap_or(Value::Null))
            .collect();
        (items, gap)
    }
}

struct Watcher {
    connection_key: u64,
    tx: mpsc::Sender<String>,
    overflowed: Arc<AtomicBool>,
}

struct SessionState {
    watchers: HashMap<u64, Watcher>,
    next_watcher_id: u64,
    disconnected_owners: HashSet<u64>,
    log: SessionLog,
    last_touched: Instant,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            watchers: HashMap::new(),
            next_watcher_id: 0,
            disconnected_owners: HashSet::new(),
            log: SessionLog::default(),
            last_touched: Instant::now(),
        }
    }
}

impl Watcher {
    fn send(&self, json: String) -> bool {
        match self.tx.try_send(json) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.overflowed.store(true, Ordering::Release);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }
}

impl SessionState {
    /// Drops watchers whose connection is gone (their forwarder task ended, so
    /// the receiver â€” and with it the channel â€” is dropped).
    fn broadcast(&mut self, json: &str, owner_key: Option<u64>) -> bool {
        let mut owner_seen = false;
        let disconnected = &mut self.disconnected_owners;
        self.watchers.retain(|_, watcher| {
            if Some(watcher.connection_key) == owner_key {
                owner_seen = true;
            }
            if watcher.send(json.to_owned()) {
                true
            } else {
                if watcher.overflowed.load(Ordering::Acquire) {
                    disconnected.insert(watcher.connection_key);
                }
                false
            }
        });
        owner_seen || owner_key.is_some_and(|key| self.disconnected_owners.contains(&key))
    }

    fn prune_closed(&mut self) {
        self.watchers.retain(|_, watcher| !watcher.tx.is_closed());
    }
}

/// Result of registering a watcher.
pub(crate) struct WatchSnapshot {
    pub(crate) watcher_id: u64,
    pub(crate) cursor: u64,
    pub(crate) epoch: String,
    #[allow(dead_code)] // lo consume el cliente por ACP; el hub solo lo escribe
    pub(crate) active_run_id: Option<String>,
    /// JSON-RPC notifications (`{"method":..,"params":..}`) the watcher needs
    /// to be up to date, oldest first. A leading `replay_gap` means the ring
    /// truncated and the client must `session/load`.
    pub(crate) replay: Vec<Value>,
}

#[derive(Default)]
pub struct SessionHub {
    /// Kept out of `SessionHub::default()` to keep the `Default` derivation
    /// honest for tests; the reaper takes its own handle from `start_reaper`.
    state: Mutex<HashMap<String, SessionState>>,
    registry: Mutex<Option<Arc<ActiveRunRegistry>>>,
}

impl SessionHub {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(HashMap::new()),
            registry: Mutex::new(None),
        }
    }

    /// TTL reaper: releases ring buffers of sessions with no watchers and no
    /// active run. Best effort, runs at most once a minute.
    pub(crate) fn start_reaper(self: &Arc<Self>, registry: Arc<ActiveRunRegistry>) {
        *self.registry.lock().expect("hub registry lock poisoned") = Some(registry.clone());
        let weak: Weak<Self> = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(REAP_INTERVAL).await;
                let Some(hub) = weak.upgrade() else {
                    return;
                };
                hub.reap_idle(&registry);
            }
        });
    }

    fn reap_idle(&self, registry: &Arc<ActiveRunRegistry>) {
        let mut state = self.state.lock().expect("hub lock poisoned");
        state.retain(|session_id, session| {
            session.prune_closed();
            if !session.watchers.is_empty() {
                return true;
            }
            if registry.agent_run(session_id).is_some() {
                return true;
            }
            if session.last_touched.elapsed() < SESSION_TTL {
                return true;
            }
            debug!(session_id, "released idle session ring buffer");
            false
        });
    }

    /// Registers `cx` as a watcher of `session_id` (idempotent per connection:
    /// a re-watch replaces the previous registration) and returns the cursor
    /// plus the replay the caller must hand back.
    pub(crate) fn watch(
        &self,
        cx: &ConnectionTo<Client>,
        connection_key: u64,
        session_id: &str,
        since: Option<u64>,
        epoch: Option<&str>,
    ) -> (WatchSnapshot, Result<(), agent_client_protocol::Error>) {
        let (tx, mut rx) = mpsc::channel::<String>(WATCHER_QUEUE_FRAMES);
        let overflowed = Arc::new(AtomicBool::new(false));
        let snapshot = {
            let mut state_map = self.state.lock().expect("hub lock poisoned");
            let state = state_map.entry(session_id.to_string()).or_default();
            state.prune_closed();
            state
                .watchers
                .retain(|_, watcher| watcher.connection_key != connection_key);
            state.disconnected_owners.remove(&connection_key);
            state.next_watcher_id += 1;
            let watcher_id = state.next_watcher_id;
            state.watchers.insert(
                watcher_id,
                Watcher {
                    connection_key,
                    tx,
                    overflowed: overflowed.clone(),
                },
            );
            state.last_touched = Instant::now();

            let (mut replay, gap) = state.log.replay(since);
            if gap || (since.is_some() && epoch != Some(state.log.epoch.as_str())) {
                replay.insert(
                    0,
                    json!({
                        "method": REPLAY_GAP_METHOD,
                        "params": { "sessionId": session_id },
                    }),
                );
            }
            WatchSnapshot {
                watcher_id,
                cursor: state.log.current_cursor(),
                epoch: state.log.epoch.clone(),
                active_run_id: state.log.active_run_id.clone(),
                replay,
            }
        };

        // The forwarder lives inside the owning connection: `cx.spawn` ties the
        // task to this connection's lifetime, so a dead connection drops `rx`
        // and the hub prunes the watcher on the next publish.
        let forward_cx = cx.clone();
        let session_id = session_id.to_owned();
        let spawned = cx.spawn(async move {
            while let Some(json) = rx.recv().await {
                let Ok(message) = serde_json::from_str::<UntypedMessage>(&json) else {
                    warn!("dropping session fan-out frame that is not a notification");
                    continue;
                };
                if forward_cx.send_notification(message).is_err() {
                    break;
                }
            }
            if overflowed.load(Ordering::Acquire) {
                let gap =
                    UntypedMessage::new(REPLAY_GAP_METHOD, json!({ "sessionId": session_id }))
                        .expect("replay gap notification");
                let _ = forward_cx.send_notification(gap);
            }
            Ok(())
        });

        (snapshot, spawned)
    }

    pub(crate) fn finish_abandoned_run(&self, session_id: &str, run_id: &str) {
        let mut state_map = self.state.lock().expect("hub lock poisoned");
        let Some(state) = state_map.get_mut(session_id) else {
            return;
        };
        if state.log.active_run_id.as_deref() != Some(run_id) {
            return;
        }
        let params =
            serde_json::to_value(agent_client_protocol::schema::v1::SessionNotification::new(
                agent_client_protocol::schema::v1::SessionId::new(session_id.to_string()),
                agent_client_protocol::schema::v1::SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::v1::SessionInfoUpdate::new()
                        .meta(active_run_meta(None)),
                ),
            ));
        let Ok(params) = params else {
            return;
        };
        let Some(json) = state.log.push("session/update", params, EventKind::RunEnd) else {
            return;
        };
        state.last_touched = Instant::now();
        state.broadcast(&json, None);
    }

    /// Removes every watcher belonging to `connection_key` (used when a
    /// connection closes a session). Returns how many were removed.
    pub(crate) fn unwatch_connection(&self, session_id: &str, connection_key: u64) -> usize {
        let mut state_map = self.state.lock().expect("hub lock poisoned");
        let Some(state) = state_map.get_mut(session_id) else {
            return 0;
        };
        let before = state.watchers.len();
        state
            .watchers
            .retain(|_, watcher| watcher.connection_key != connection_key);
        let removed = before - state.watchers.len();
        state.disconnected_owners.remove(&connection_key);
        state.last_touched = Instant::now();
        removed
    }

    /// Live watcher count, after pruning watchers whose connection died.
    pub(crate) fn watcher_count(&self, session_id: &str) -> usize {
        let mut state_map = self.state.lock().expect("hub lock poisoned");
        match state_map.get_mut(session_id) {
            Some(state) => {
                state.prune_closed();
                state.watchers.len()
            }
            None => 0,
        }
    }

    /// Frees the ring when the session has no watchers and no active run.
    pub(crate) fn release_if_idle(&self, session_id: &str, registry: &ActiveRunRegistry) {
        let mut state_map = self.state.lock().expect("hub lock poisoned");
        let Some(state) = state_map.get_mut(session_id) else {
            return;
        };
        state.prune_closed();
        if state.watchers.is_empty() && registry.agent_run(session_id).is_none() {
            state_map.remove(session_id);
        }
    }

    /// Assigns a cursor, appends to the session ring and forwards to every
    /// watcher. Never blocks: the lock covers map/queue work and non-blocking
    /// sends only.
    ///
    /// Returns `Some(json)` when `owner_key` names a connection that is **not**
    /// a (live) watcher of the session: the caller must deliver that frame on
    /// its own connection so a client that never called `watch` keeps working.
    pub(crate) fn publish(
        &self,
        session_id: &str,
        method: &str,
        params: &Value,
        kind: EventKind,
        owner_key: Option<u64>,
    ) -> Option<String> {
        let mut state_map = self.state.lock().expect("hub lock poisoned");
        let state = state_map.entry(session_id.to_string()).or_default();
        let Some(json) = state.log.push(method, params.clone(), kind) else {
            warn!(
                session_id,
                "failed to serialize or number session fan-out frame"
            );
            return None;
        };
        state.last_touched = Instant::now();

        let owner_seen = state.broadcast(&json, owner_key);
        if owner_key.is_some() && !owner_seen {
            Some(json)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{EventKind, SessionLog, MAX_EVENTS};
    use serde_json::json;

    #[test]
    fn slow_watcher_is_detached_and_can_replay_from_last_cursor() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::sync::mpsc;

        let hub = super::SessionHub::new();
        let (slow_tx, mut slow_rx) = mpsc::channel(super::WATCHER_QUEUE_FRAMES);
        let (fast_tx, mut fast_rx) = mpsc::channel(super::WATCHER_QUEUE_FRAMES);
        let overflowed = Arc::new(AtomicBool::new(false));
        {
            let mut sessions = hub.state.lock().unwrap();
            let state = sessions.entry("s".into()).or_default();
            state.watchers.insert(
                1,
                super::Watcher {
                    connection_key: 1,
                    tx: slow_tx,
                    overflowed: overflowed.clone(),
                },
            );
            state.watchers.insert(
                2,
                super::Watcher {
                    connection_key: 2,
                    tx: fast_tx,
                    overflowed: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        for cursor in 1..=super::WATCHER_QUEUE_FRAMES {
            hub.publish(
                "s",
                "session/update",
                &json!({"event":cursor}),
                EventKind::Normal,
                Some(1),
            );
            let fast = fast_rx.try_recv().unwrap();
            assert!(fast.contains(&format!(r#""cursor":{cursor}"#)));
        }
        assert!(hub
            .publish(
                "s",
                "session/update",
                &json!({"event":65}),
                EventKind::Normal,
                Some(1)
            )
            .is_none());
        assert!(overflowed.load(Ordering::Acquire));
        assert_eq!(hub.watcher_count("s"), 1);
        assert!(fast_rx.try_recv().unwrap().contains(r#""cursor":65"#));
        for cursor in 1..=super::WATCHER_QUEUE_FRAMES {
            let slow = slow_rx.try_recv().unwrap();
            assert!(slow.contains(&format!(r#""cursor":{cursor}"#)));
        }
        assert!(slow_rx.try_recv().is_err());
        let sessions = hub.state.lock().unwrap();
        let log = &sessions.get("s").unwrap().log;
        let (replay, gap) = log.replay(Some(super::WATCHER_QUEUE_FRAMES as u64));
        assert!(!gap);
        assert_eq!(replay.len(), 1);
        assert_eq!(
            replay[0].pointer("/params/_meta/aegis/cursor"),
            Some(&json!(65))
        );
    }
    #[test]
    fn late_watcher_replays_from_the_run_start_not_from_the_beginning() {
        let hub = super::SessionHub::new();
        for cursor in 1..=3 {
            hub.publish(
                "s",
                "session/update",
                &json!({"event":cursor}),
                EventKind::Normal,
                None,
            );
        }
        // Arranca el run: un watcher que llega con `since: null` tiene que recibir desde aca.
        let start = json!({"sessionId":"s","update":{"sessionUpdate":"session_info_update","_meta":{"aegis":{"activeRunId":"run-1"}}}});
        hub.publish("s", "session/update", &start, EventKind::RunStart, None);
        for cursor in 4..=5 {
            hub.publish(
                "s",
                "session/update",
                &json!({"event":cursor}),
                EventKind::Normal,
                None,
            );
        }

        let sessions = hub.state.lock().unwrap();
        let log = &sessions.get("s").unwrap().log;
        let (replay, gap) = log.replay(None);
        assert!(!gap, "con el ring intacto no puede haber gap");
        assert_eq!(
            replay.len(),
            3,
            "un watcher tardio recibe el arranque del run y lo que vino despues, no los eventos previos"
        );
        assert_eq!(
            replay[0].pointer("/params/update/_meta/aegis/activeRunId"),
            Some(&json!("run-1")),
            "el primero del replay es el marcador de arranque: {}",
            replay[0]
        );
        assert_eq!(
            replay[1].pointer("/params/_meta/aegis/cursor"),
            Some(&json!(5))
        );
        assert_eq!(
            replay[2].pointer("/params/_meta/aegis/cursor"),
            Some(&json!(6))
        );
    }
    #[test]
    fn abandoned_run_emits_one_terminal_marker_and_never_clears_replacement() {
        let hub = super::SessionHub::new();
        let start = json!({"sessionId":"s","update":{"sessionUpdate":"session_info_update","_meta":{"aegis":{"activeRunId":"run-1"}}}});
        hub.publish("s", "session/update", &start, EventKind::RunStart, None);
        hub.finish_abandoned_run("s", "run-1");
        hub.finish_abandoned_run("s", "run-1");
        let state = hub.state.lock().unwrap();
        let log = &state.get("s").unwrap().log;
        assert!(log.active_run_id.is_none());
        assert_eq!(log.current_cursor(), 2);
        assert_eq!(
            log.replay(Some(1)).0[0].pointer("/params/update/_meta/aegis/activeRunId"),
            Some(&serde_json::Value::Null)
        );
        drop(state);
        hub.publish("s", "session/update", &json!({"sessionId":"s","update":{"sessionUpdate":"session_info_update","_meta":{"aegis":{"activeRunId":"run-2"}}}}), EventKind::RunStart, None);
        hub.finish_abandoned_run("s", "run-1");
        assert_eq!(
            hub.state
                .lock()
                .unwrap()
                .get("s")
                .unwrap()
                .log
                .active_run_id
                .as_deref(),
            Some("run-2")
        );
    }

    #[test]
    fn cursor_identifies_last_published_event_and_replay_excludes_applied_event() {
        let mut log = SessionLog::default();
        assert_eq!(log.current_cursor(), 0);
        assert!(log
            .push("session/update", json!({"event": 1}), EventKind::Normal)
            .is_some());
        assert_eq!(log.current_cursor(), 1);
        assert_eq!(
            log.replay(Some(0)),
            (
                vec![
                    json!({"method":"session/update", "params":{"event":1,"_meta":{"aegis":{"cursor":1}}}})
                ],
                false
            )
        );
        assert_eq!(log.replay(Some(1)), (vec![], false));
        assert!(log
            .push("session/update", json!({"event": 2}), EventKind::Normal)
            .is_some());
        assert_eq!(
            log.replay(Some(1)),
            (
                vec![
                    json!({"method":"session/update", "params":{"event":2,"_meta":{"aegis":{"cursor":2}}}})
                ],
                false
            )
        );
        assert_eq!(log.replay(None), (vec![], false));
    }

    #[test]
    fn evicted_cursor_reports_gap_but_last_retained_cursor_does_not() {
        let mut log = SessionLog::default();
        for cursor in 1..=(MAX_EVENTS as u64 + 1) {
            assert!(log
                .push("session/update", json!({"event":cursor}), EventKind::Normal)
                .is_some());
        }
        assert_eq!(log.current_cursor(), MAX_EVENTS as u64 + 1);
        let (replay, gap) = log.replay(Some(0));
        assert!(gap);
        assert_eq!(
            replay.first(),
            Some(
                &json!({"method":"session/update", "params":{"event":2,"_meta":{"aegis":{"cursor":2}}}})
            )
        );
        assert!(!log.replay(Some(1)).1);
    }
    #[test]
    fn run_marker_and_cursor_share_snapshot_boundary() {
        let mut log = SessionLog::default();
        let start = json!({"sessionId":"s","update":{"sessionUpdate":"session_info_update","_meta":{"aegis":{"activeRunId":"run-1"}}}});
        let live = log
            .push("session/update", start, EventKind::RunStart)
            .unwrap();
        assert_eq!(log.active_run_id.as_deref(), Some("run-1"));
        assert_eq!(log.current_cursor(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&live)
                .unwrap()
                .pointer("/params/_meta/aegis/cursor"),
            Some(&json!(1))
        );
        assert_eq!(
            log.replay(None).0[0].pointer("/params/_meta/aegis/cursor"),
            Some(&json!(1))
        );
        log.push(
            "session/update",
            json!({"update":{"sessionUpdate":"session_info_update"}}),
            EventKind::RunEnd,
        );
        assert!(log.active_run_id.is_none());
        assert_eq!(
            log.replay(None).0[0].pointer("/params/_meta/aegis/cursor"),
            Some(&json!(2))
        );
    }

    #[test]
    fn ring_epoch_changes_when_a_session_log_is_recreated() {
        let original = SessionLog::default();
        let replacement = SessionLog::default();
        assert_eq!(original.current_cursor(), replacement.current_cursor());
        assert_ne!(original.epoch, replacement.epoch);
    }

    #[test]
    fn future_cursor_and_oversized_event_report_gap() {
        let mut log = SessionLog::default();
        log.push(
            "session/update",
            json!({"data":"x".repeat(super::MAX_BYTES)}),
            EventKind::Normal,
        );
        assert!(log.replay(Some(0)).1);
        assert!(log.replay(Some(100)).1);
    }
}

/// Session-scoped emitter handed to the code paths that stream a turn.
///
/// It carries the owning connection so a client that never called `watch`
/// still receives everything, and the hub so every event also reaches the
/// other watchers of the session.
#[derive(Clone)]
pub(crate) struct SessionBus {
    hub: Arc<SessionHub>,
    connection: ConnectionTo<Client>,
    connection_key: u64,
}

impl SessionBus {
    pub(crate) fn new(
        hub: Arc<SessionHub>,
        connection: ConnectionTo<Client>,
        connection_key: u64,
    ) -> Self {
        Self {
            hub,
            connection,
            connection_key,
        }
    }

    /// The owning connection, for messages that must not be fanned out
    /// (`session/request_permission`, elicitation, config updates...).
    pub(crate) fn connection(&self) -> &ConnectionTo<Client> {
        &self.connection
    }

    /// Fans a session notification out to every watcher of the session. A
    /// delivery failure on the owning connection is logged, never propagated:
    /// losing a socket must not abort the turn.
    pub(crate) fn emit<N: JsonRpcNotification + Serialize>(
        &self,
        session_id: &str,
        notification: N,
    ) {
        self.emit_kind(session_id, notification, EventKind::Normal);
    }

    pub(crate) fn emit_kind<N: JsonRpcNotification + Serialize>(
        &self,
        session_id: &str,
        notification: N,
        kind: EventKind,
    ) {
        let method = agent_client_protocol::JsonRpcMessage::method(&notification).to_string();
        let params = match serde_json::to_value(&notification) {
            Ok(params) => params,
            Err(error) => {
                warn!(session_id, %error, "failed to serialize session notification");
                return;
            }
        };
        let direct = self.hub.publish(
            session_id,
            &method,
            &params,
            kind,
            Some(self.connection_key),
        );
        if let Some(json) = direct {
            let message =
                serde_json::from_str::<UntypedMessage>(&json).expect("published notification");
            if let Err(error) = self.connection.send_notification(message) {
                debug!(session_id, %error, "session update dropped: owner connection is gone");
            }
        }
    }

    /// `_aegis/unstable/session/update` carrying `aegis.activeRunId`. `kind`
    /// must be `RunStart`/`RunEnd` so the replay window follows the run.
    pub(crate) fn emit_active_run(
        &self,
        session_id: &str,
        active_run_id: Option<&str>,
        kind: EventKind,
    ) {
        let notification = agent_client_protocol::schema::v1::SessionNotification::new(
            agent_client_protocol::schema::v1::SessionId::new(session_id.to_string()),
            agent_client_protocol::schema::v1::SessionUpdate::SessionInfoUpdate(
                agent_client_protocol::schema::v1::SessionInfoUpdate::new()
                    .meta(active_run_meta(active_run_id)),
            ),
        );
        self.emit_kind(session_id, notification, kind);
    }
}

/// `_meta.aegis.activeRunId` payload used by run start/stop notifications.
pub(crate) fn active_run_meta(
    active_run_id: Option<&str>,
) -> agent_client_protocol::schema::v1::Meta {
    let mut aegis = serde_json::Map::new();
    aegis.insert(
        "activeRunId".to_string(),
        active_run_id
            .map(|run_id| Value::String(run_id.to_string()))
            .unwrap_or(Value::Null),
    );

    let mut meta = serde_json::Map::new();
    meta.insert("aegis".to_string(), Value::Object(aegis));
    meta
}
