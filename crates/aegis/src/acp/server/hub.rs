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
//!   `UnboundedSender::send`. It cannot stall the agent stream.
//! * A bounded ring buffer per session (500 events / 2 MB) lets a late or
//!   reconnecting watcher catch up. When the ring dropped events the watcher
//!   is told with `replay_gap` and must do a full `session/load`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use agent_client_protocol::{Client, ConnectionTo, JsonRpcNotification, UntypedMessage};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::execution::ActiveRunRegistry;

/// Maximum events kept per session ring buffer.
pub(crate) const MAX_EVENTS: usize = 500;
/// Maximum bytes kept per session ring buffer.
pub(crate) const MAX_BYTES: usize = 2 * 1024 * 1024;
/// Idle sessions (no watchers, no active run) release their ring after this.
const SESSION_TTL: Duration = Duration::from_secs(600);
const REAP_INTERVAL: Duration = Duration::from_secs(60);

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

#[derive(Default)]
struct SessionLog {
    entries: VecDeque<RingEntry>,
    bytes: usize,
    next_cursor: u64,
    /// Cursor a `since: null` watcher should start from (the current or last
    /// run boundary); `None` means "from now".
    replay_from: Option<u64>,
}

impl SessionLog {
    fn current_cursor(&self) -> u64 {
        self.next_cursor.saturating_sub(1)
    }

    fn oldest_cursor(&self) -> u64 {
        self.entries
            .front()
            .map(|entry| entry.cursor)
            .unwrap_or(self.next_cursor)
    }

    fn push(&mut self, json: String, kind: EventKind) -> u64 {
        self.next_cursor += 1;
        let cursor = self.next_cursor;
        self.bytes += json.len();
        self.entries.push_back(RingEntry {
            cursor,
            json: Arc::new(json),
        });
        match kind {
            EventKind::RunStart | EventKind::RunEnd => self.replay_from = Some(cursor),
            EventKind::Normal => {}
        }
        while self.entries.len() > MAX_EVENTS || self.bytes > MAX_BYTES {
            let Some(dropped) = self.entries.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(dropped.json.len());
        }
        cursor
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
        let gap = from + 1 < self.oldest_cursor();
        let items = self
            .entries
            .iter()
            .filter(|entry| entry.cursor > from)
            .map(|entry| {
                serde_json::from_str::<Value>(&entry.json).unwrap_or(Value::Null)
            })
            .collect();
        (items, gap)
    }
}

struct Watcher {
    connection_key: u64,
    tx: mpsc::UnboundedSender<String>,
}

struct SessionState {
    watchers: HashMap<u64, Watcher>,
    next_watcher_id: u64,
    log: SessionLog,
    last_touched: Instant,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            watchers: HashMap::new(),
            next_watcher_id: 0,
            log: SessionLog::default(),
            last_touched: Instant::now(),
        }
    }
}

impl SessionState {
    /// Drops watchers whose connection is gone (their forwarder task ended, so
    /// the receiver — and with it the channel — is dropped).
    fn prune_closed(&mut self) {
        self.watchers.retain(|_, watcher| !watcher.tx.is_closed());
    }
}

/// Result of registering a watcher.
pub(crate) struct WatchSnapshot {
    pub(crate) watcher_id: u64,
    pub(crate) cursor: u64,
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
    ) -> (WatchSnapshot, Result<(), agent_client_protocol::Error>) {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let snapshot = {
            let mut state_map = self.state.lock().expect("hub lock poisoned");
            let state = state_map
                .entry(session_id.to_string())
                .or_insert_with(SessionState::default);
            state.prune_closed();
            state
                .watchers
                .retain(|_, watcher| watcher.connection_key != connection_key);
            state.next_watcher_id += 1;
            let watcher_id = state.next_watcher_id;
            state.watchers.insert(
                watcher_id,
                Watcher {
                    connection_key,
                    tx,
                },
            );
            state.last_touched = Instant::now();

            let (mut replay, gap) = state.log.replay(since);
            if gap {
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
                replay,
            }
        };

        // The forwarder lives inside the owning connection: `cx.spawn` ties the
        // task to this connection's lifetime, so a dead connection drops `rx`
        // and the hub prunes the watcher on the next publish.
        let forward_cx = cx.clone();
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
            Ok(())
        });

        (snapshot, spawned)
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
        let json = match serde_json::to_string(&UntypedMessage {
            method: method.to_string(),
            params: params.clone(),
        }) {
            Ok(json) => json,
            Err(error) => {
                warn!(session_id, %error, "failed to serialize session fan-out frame");
                return None;
            }
        };

        let mut owner_seen = false;
        let mut state_map = self.state.lock().expect("hub lock poisoned");
        let state = state_map
            .entry(session_id.to_string())
            .or_insert_with(SessionState::default);
        state.log.push(json.clone(), kind);
        state.last_touched = Instant::now();

        let mut dead = Vec::new();
        for (watcher_id, watcher) in state.watchers.iter() {
            if watcher.tx.send(json.clone()).is_err() {
                dead.push(*watcher_id);
            } else if Some(watcher.connection_key) == owner_key {
                owner_seen = true;
            }
        }
        for watcher_id in dead {
            state.watchers.remove(&watcher_id);
        }

        if owner_key.is_some() && !owner_seen {
            Some(json)
        } else {
            None
        }
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
    pub(crate) fn emit<N: JsonRpcNotification + Serialize>(&self, session_id: &str, notification: N) {
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
        if direct.is_some() {
            if let Err(error) = self.connection.send_notification(notification) {
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
pub(crate) fn active_run_meta(active_run_id: Option<&str>) -> agent_client_protocol::schema::v1::Meta {
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
