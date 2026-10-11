//! Local CLI presentation state. This module does not query a provider, git, or the filesystem.
//! Feed it observed events and a fresh `Session`; `None` means unavailable, not zero.

use serde_json::{Map, Value};
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use goose::providers::base::{CostSource, ProviderUsage, Usage};
use goose::session::Session;

const ROLLING_WINDOW: usize = 8;

#[derive(Debug, Clone, Copy)]
struct ApiSample {
    duration: Option<Duration>,
    output_tokens: Option<u64>,
}

/// Runtime observations plus the most recently fetched persistent session snapshot.
/// Call `refresh_session` after a model switch or when persistent usage changes.
#[derive(Debug)]
pub struct SessionTelemetry {
    pub session_started_at: DateTime<Utc>,
    pub turn_started_at: Option<Instant>,
    pub response_ttft: Option<Duration>,
    pub context_limit: Option<usize>,
    /// Token ceiling where goose starts compacting; the status bar shows this
    /// instead of the provider's advertised window, which is the one that does
    /// not actually bite.
    compaction_limit: Option<usize>,
    pub compaction_count: Option<u64>,
    pub background_jobs: Option<usize>,
    pub git_branch: Option<String>,
    pub cwd: PathBuf,
    pub mode: String,
    pub session_name: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub context_usage: Usage,
    pub accumulated_usage: Usage,
    /// Session cost may mix provider-reported and estimated amounts: provenance unavailable.
    pub session_cost_usd: Option<f64>,
    samples: VecDeque<ApiSample>,
    turn_api_count: usize,
    turn_usage: Usage,
    turn_cost_usd: Option<f64>,
    turn_cost_all_reported: bool,
    turn_first_text_at: Option<Instant>,
    cache_read_for_model: Option<u64>,
    cache_write_for_model: Option<u64>,
    input_for_model: Option<u64>,
    cache_reporting_complete: bool,
    observed_tool_ids: HashSet<String>,
    read_files: HashSet<String>,
    edited_files: HashSet<String>,
    commands_run: usize,
    subagents_started: usize,
}

impl SessionTelemetry {
    pub fn new(session: &Session) -> Self {
        let mut state = Self {
            session_started_at: session.created_at,
            turn_started_at: None,
            response_ttft: None,
            context_limit: None,
            compaction_limit: None,
            compaction_count: None,
            background_jobs: None,
            git_branch: None,
            cwd: session.working_dir.clone(),
            mode: session.goose_mode.to_string(),
            session_name: session.name.clone(),
            provider: session.provider_name.clone(),
            model: session.model_config.as_ref().map(|m| m.model_name.clone()),
            context_usage: session.usage,
            accumulated_usage: session.accumulated_usage,
            session_cost_usd: session
                .accumulated_cost
                .filter(|c| c.is_finite() && *c >= 0.0),
            samples: VecDeque::new(),
            turn_api_count: 0,
            turn_usage: Usage::default(),
            turn_cost_usd: None,
            turn_cost_all_reported: true,
            turn_first_text_at: None,
            cache_read_for_model: None,
            cache_write_for_model: None,
            input_for_model: None,
            cache_reporting_complete: true,
            observed_tool_ids: HashSet::new(),
            read_files: HashSet::new(),
            edited_files: HashSet::new(),
            commands_run: 0,
            subagents_started: 0,
        };
        state.refresh_session(session);
        state
    }

    pub fn refresh_session(&mut self, session: &Session) {
        let new_model = session.model_config.as_ref().map(|m| m.model_name.clone());
        if self.model != new_model || self.provider != session.provider_name {
            self.samples.clear();
            self.cache_read_for_model = None;
            self.cache_write_for_model = None;
            self.input_for_model = None;
            self.cache_reporting_complete = true;
            self.context_limit = None;
        }
        self.session_started_at = session.created_at;
        self.provider = session.provider_name.clone();
        self.model = new_model;
        self.cwd = session.working_dir.clone();
        self.mode = session.goose_mode.to_string();
        self.session_name = session.name.clone();
        self.context_usage = session.usage;
        self.accumulated_usage = session.accumulated_usage;
        self.session_cost_usd = session
            .accumulated_cost
            .filter(|c| c.is_finite() && *c >= 0.0);
    }

    /// Set only after querying the active provider; do not use a default model limit.
    pub fn set_context_limit(&mut self, limit: Option<usize>) {
        self.context_limit = limit.filter(|limit| *limit > 0);
    }

    /// `GOOSE_AUTO_COMPACT_TOKEN_LIMIT`, when configured. Shown in the status bar
    /// beside the model window so an oversized request is visible before the
    /// provider or the compactor rejects it.
    pub fn set_compaction_limit(&mut self, limit: Option<usize>) {
        self.compaction_limit = limit.filter(|limit| *limit > 0);
    }

    pub fn start_turn(&mut self, now: Instant) {
        self.turn_started_at = Some(now);
        self.turn_first_text_at = None;
        self.response_ttft = None;
        self.turn_usage = Usage::default();
        self.turn_api_count = 0;
        self.turn_cost_usd = None;
        self.turn_cost_all_reported = true;
        self.observed_tool_ids.clear();
        self.read_files.clear();
        self.edited_files.clear();
        self.commands_run = 0;
        self.subagents_started = 0;
    }

    pub fn record_tool_request(&mut self, id: &str, name: &str, args: Option<&Map<String, Value>>) {
        if !self.observed_tool_ids.insert(id.to_owned()) {
            return;
        }
        let tool = name.rsplit("__").next().unwrap_or(name);
        match tool {
            "read" | "read_file" => {
                if let Some(path) = args.and_then(tool_path) {
                    self.read_files.insert(path);
                }
            }
            "write" | "write_file" | "edit" | "patch" => {
                if let Some(path) = args.and_then(tool_path) {
                    self.edited_files.insert(path);
                }
            }
            "shell" | "execute_code" | "execute_typescript" => self.commands_run += 1,
            "summon" | "delegate_task" => self.subagents_started += 1,
            _ => {}
        }
    }

    /// Call on the first *visible text* chunk, not thinking or tool events.
    pub fn observe_text(&mut self, now: Instant) {
        if let Some(start) = self.turn_started_at {
            if self.turn_first_text_at.is_none() && now >= start {
                self.turn_first_text_at = Some(now);
                self.response_ttft = Some(now.duration_since(start));
            }
        }
    }

    /// Each `AgentEvent::Usage` represents one API response. Pass `None` if its
    /// individual latency was not measured; a whole turn is not an API latency.
    pub fn record_api_response(&mut self, usage: &ProviderUsage, duration: Option<Duration>) {
        let output_tokens = usage
            .usage
            .output_tokens
            .and_then(|v| u64::try_from(v).ok())
            .or_else(|| {
                usage
                    .stats
                    .as_ref()
                    .and_then(|s| s.output_tokens.map(|v| v as u64))
            });
        self.samples.push_back(ApiSample {
            duration,
            output_tokens,
        });
        self.turn_api_count = self.turn_api_count.saturating_add(1);
        if self.samples.len() > ROLLING_WINDOW {
            self.samples.pop_front();
        }
        self.turn_usage += usage.usage;
        if usage.usage.input_tokens.is_some() && usage.usage.cache_read_input_tokens.is_none() {
            self.cache_reporting_complete = false;
        }
        add_counter(&mut self.input_for_model, usage.usage.input_tokens);
        add_counter(
            &mut self.cache_read_for_model,
            usage.usage.cache_read_input_tokens,
        );
        add_counter(
            &mut self.cache_write_for_model,
            usage.usage.cache_write_input_tokens,
        );
        match (usage.cost, usage.cost_source) {
            (Some(cost), Some(CostSource::ProviderReported))
                if cost.is_finite() && cost >= 0.0 && self.turn_cost_all_reported =>
            {
                self.turn_cost_usd = Some(self.turn_cost_usd.unwrap_or(0.0) + cost);
            }
            _ => {
                self.turn_cost_all_reported = false;
                self.turn_cost_usd = None;
            }
        }
    }

    pub fn observe_compaction(&mut self) {
        self.compaction_count = Some(self.compaction_count.unwrap_or(0).saturating_add(1));
    }

    /// Seed from an authoritative count when resuming; otherwise leave unavailable.
    pub fn set_compaction_count(&mut self, count: Option<u64>) {
        self.compaction_count = count;
    }

    /// Pass an actual scheduler/job count. `None` means it could not be obtained.
    pub fn set_background_jobs(&mut self, count: Option<usize>) {
        self.background_jobs = count;
    }

    /// Pass a branch only when git is known to be available in this working tree.
    pub fn set_git_branch(&mut self, branch: Option<String>) {
        self.git_branch = branch;
    }

    pub fn cache_hit_pct(&self) -> Option<f64> {
        if !self.cache_reporting_complete {
            return None;
        }
        match (self.cache_read_for_model, self.input_for_model) {
            (Some(read), Some(input)) if input > 0 && read <= input => {
                Some(read as f64 / input as f64 * 100.0)
            }
            _ => None,
        }
    }

    pub fn rolling_api_duration(&self) -> Option<Duration> {
        let observed: Vec<_> = self.samples.iter().filter_map(|s| s.duration).collect();
        (!observed.is_empty()).then(|| {
            Duration::from_secs_f64(
                observed.iter().map(|s| s.as_secs_f64()).sum::<f64>() / observed.len() as f64,
            )
        })
    }

    pub fn rolling_output_tokens(&self) -> Option<u64> {
        let observed: Vec<_> = self
            .samples
            .iter()
            .filter_map(|s| s.output_tokens)
            .collect();
        (!observed.is_empty()).then(|| observed.iter().sum::<u64>() / observed.len() as u64)
    }

    pub fn rolling_tokens_per_second(&self) -> Option<f64> {
        let (tokens, seconds) = self
            .samples
            .iter()
            .filter_map(|s| {
                s.output_tokens
                    .zip(s.duration)
                    .filter(|(_, duration)| !duration.is_zero())
                    .map(|(t, duration)| (t, duration.as_secs_f64()))
            })
            .fold((0u64, 0.0), |(tokens, seconds), (t, s)| {
                (tokens.saturating_add(t), seconds + s)
            });
        (seconds > 0.0).then_some(tokens as f64 / seconds)
    }

    /// Compact live readout; the full set of counters is in `/usage`.
    pub fn status_bar(&self, now: DateTime<Utc>) -> String {
        let context = match (self.context_usage.total_tokens, self.context_limit) {
            (Some(used), Some(limit)) if used >= 0 => {
                let cap = self.compaction_limit.filter(|cap| *cap > 0);
                let shown = cap.map_or(limit, |cap| limit.min(cap));
                let over = cap.is_some_and(|cap| used as u64 >= cap as u64);
                format!(
                    "{used}/{shown} ({:.0}%){}",
                    used as f64 / shown as f64 * 100.0,
                    if over { " ⚠ compactar" } else { "" }
                )
            }
            _ => "—".into(),
        };
        let cache = self
            .cache_hit_pct()
            .map_or_else(|| "—".into(), |pct| format!("{pct:.1}%"));
        let speed = self
            .rolling_tokens_per_second()
            .map_or_else(|| "—".into(), |tps| format!("{tps:.0} t/s"));
        let turn = self
            .turn_started_at
            .and_then(|start| Instant::now().checked_duration_since(start));
        format!(
            "{} / {} | ctx {} | cache {} | {} | turno {} | sesion {}",
            one_line(self.provider.as_deref().unwrap_or("—")),
            one_line(self.model.as_deref().unwrap_or("—")),
            context,
            cache,
            speed,
            fmt_duration(turn),
            fmt_duration(elapsed_since(self.session_started_at, now)),
        )
    }

    /// Plain-text detailed `/usage` output. Persistent usage is not the current context size.
    pub fn usage_report(&self, now: DateTime<Utc>) -> String {
        let mut lines = vec![
            format!("Session: {}", one_line(&self.session_name)),
            format!("Session started: {}", self.session_started_at.to_rfc3339()),
            format!(
                "Elapsed: {}",
                fmt_duration(elapsed_since(self.session_started_at, now))
            ),
            format!(
                "Provider / model: {} / {}",
                one_line(self.provider.as_deref().unwrap_or("unavailable")),
                one_line(self.model.as_deref().unwrap_or("unavailable"))
            ),
            format!("Mode: {}", one_line(&self.mode)),
            format!(
                "Working directory: {}",
                one_line(&self.cwd.to_string_lossy())
            ),
            format!(
                "Git branch: {}",
                one_line(self.git_branch.as_deref().unwrap_or("unavailable"))
            ),
            format!(
                "Context (current snapshot): {} / {} tokens",
                fmt_option(self.context_usage.total_tokens),
                fmt_option(self.context_limit)
            ),
        ];
        append_usage(&mut lines, "Session stored", self.accumulated_usage);
        lines.push("Stored cache counters may show 0 when a provider omits cache data; the cache-hit percentage above requires complete observed reports.".into());
        lines.extend([
            format!(
                "Session recorded cost (source unverified): {}",
                fmt_cost(self.session_cost_usd)
            ),
            format!(
                "Rolling API response: {} (last {} responses)",
                fmt_duration(self.rolling_api_duration()),
                self.samples.len()
            ),
            format!(
                "Rolling output tokens: {} average",
                fmt_option(self.rolling_output_tokens())
            ),
            format!(
                "Rolling output rate: {}",
                self.rolling_tokens_per_second()
                    .map_or_else(|| "unavailable".into(), |v| format!("{v:.1} tokens/s"))
            ),
            format!(
                "Cache hit (observed current model): {}",
                self.cache_hit_pct()
                    .map_or_else(|| "unavailable".into(), |v| format!("{v:.1}%"))
            ),
            format!(
                "Cache read (current model, observed): {}",
                fmt_option(self.cache_read_for_model)
            ),
            format!(
                "Cache write (current model, observed): {}",
                fmt_option(self.cache_write_for_model)
            ),
            format!("First visible text: {}", fmt_duration(self.response_ttft)),
            format!("Compactions: {}", fmt_option(self.compaction_count)),
            format!("Background jobs: {}", fmt_option(self.background_jobs)),
        ]);
        lines.join("\n")
    }

    /// One-line turn recap for the conversation area.
    ///
    /// The full counter set is noise after every turn, so the transcript keeps a
    /// single scannable line and `/usage` remains the place for detail.
    pub fn turn_summary(&self, now: Instant) -> String {
        let elapsed = self
            .turn_started_at
            .and_then(|start| now.checked_duration_since(start));
        let mut parts = vec![
            format!("turn {}", fmt_duration(elapsed)),
            format!(
                "in {} / out {} tok",
                fmt_option(self.turn_usage.input_tokens),
                fmt_option(self.turn_usage.output_tokens)
            ),
            format!("{} api", self.turn_api_count),
            format!("{} tools", self.observed_tool_ids.len()),
        ];
        let files = self.read_files.len() + self.edited_files.len();
        if files > 0 {
            parts.push(format!("{files} files"));
        }
        if self.commands_run > 0 {
            parts.push(format!("{} cmds", self.commands_run));
        }
        if self.subagents_started > 0 {
            parts.push(format!("{} subagents", self.subagents_started));
        }
        if self.turn_cost_usd.is_some() {
            parts.push(format!("cost {}", fmt_cost(self.turn_cost_usd)));
        }
        parts.join(" | ")
    }
}

fn tool_path(args: &Map<String, Value>) -> Option<String> {
    ["path", "file_path", "target_file", "filename"]
        .iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
        .map(|path| one_line(path).chars().take(160).collect())
}

fn add_counter(target: &mut Option<u64>, value: Option<i32>) {
    if let Some(value) = value.and_then(|v| u64::try_from(v).ok()) {
        *target = Some(target.unwrap_or(0).saturating_add(value));
    }
}

fn append_usage(lines: &mut Vec<String>, label: &str, usage: Usage) {
    lines.push(format!(
        "{label} input: {} tokens",
        fmt_option(usage.input_tokens)
    ));
    lines.push(format!(
        "{label} output: {} tokens",
        fmt_option(usage.output_tokens)
    ));
    lines.push(format!(
        "{label} total: {} tokens",
        fmt_option(usage.total_tokens)
    ));
    lines.push(format!(
        "{label} cache read: {} tokens",
        fmt_option(usage.cache_read_input_tokens)
    ));
    lines.push(format!(
        "{label} cache write: {} tokens",
        fmt_option(usage.cache_write_input_tokens)
    ));
}

fn fmt_option<T: std::fmt::Display>(value: Option<T>) -> String {
    value.map_or_else(|| "unavailable".into(), |v| v.to_string())
}

fn fmt_cost(value: Option<f64>) -> String {
    value.map_or_else(|| "unavailable".into(), |v| format!("${v:.4}"))
}

fn fmt_duration(value: Option<Duration>) -> String {
    value.map_or_else(
        || "unavailable".into(),
        |v| format!("{:.1}s", v.as_secs_f64()),
    )
}

fn elapsed_since(start: DateTime<Utc>, now: DateTime<Utc>) -> Option<Duration> {
    now.signed_duration_since(start).to_std().ok()
}

fn one_line(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() && *c != '\u{1b}')
        .take(80)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use goose::config::GooseMode;
    use goose::providers::base::Usage;
    use goose::session::SessionType;

    fn session() -> Session {
        let mut session = serde_json::from_value::<Session>(serde_json::json!({
            "id": "telemetry-test", "working_dir": "C:/goose", "name": "test",
            "session_type": "user", "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z", "extension_data": {},
            "accumulated_cost": null, "schedule_id": null, "recipe": null,
            "user_recipe_values": null, "conversation": null, "message_count": 0,
            "provider_name": null, "model_config": null
        }))
        .expect("valid session fixture");
        session.session_type = SessionType::User;
        session.goose_mode = GooseMode::Auto;
        session
    }

    fn response(
        model: &str,
        output: Option<i32>,
        read: Option<i32>,
        write: Option<i32>,
    ) -> ProviderUsage {
        ProviderUsage::new(
            model.into(),
            Usage::new(Some(100), output, None).with_cache_tokens(read, write),
        )
    }

    #[test]
    fn unavailable_is_not_zero_and_cost_is_not_invented() {
        let t = SessionTelemetry::new(&session());
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:01:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let report = t.usage_report(now);
        assert!(report.contains("Context (current snapshot): unavailable / unavailable"));
        assert!(report.contains("Session recorded cost (source unverified): unavailable"));
        assert!(report.contains("First visible text: unavailable"));
        assert!(report.contains("Background jobs: unavailable"));
        assert!(t.status_bar(now).contains("unavailable"));
    }

    #[test]
    fn tracks_visible_text_and_rolling_samples_without_zero_denominator() {
        let mut t = SessionTelemetry::new(&session());
        let now = Instant::now();
        t.start_turn(now);
        t.observe_text(now + Duration::from_millis(340));
        t.observe_text(now + Duration::from_secs(2));
        assert_eq!(t.response_ttft, Some(Duration::from_millis(340)));
        t.record_api_response(
            &response("a", Some(40), Some(12), None),
            Some(Duration::from_secs(2)),
        );
        t.record_api_response(&response("a", None, None, Some(3)), None);
        assert_eq!(t.rolling_output_tokens(), Some(40));
        assert_eq!(t.rolling_tokens_per_second(), Some(20.0));
        assert_eq!(t.cache_read_for_model, Some(12));
        assert_eq!(t.cache_write_for_model, Some(3));
        assert!(t
            .turn_summary(now + Duration::from_secs(3))
            .contains("out 40 tok"));
        t.start_turn(now + Duration::from_secs(4));
        assert_eq!(t.response_ttft, None);
        assert_eq!(t.turn_usage.output_tokens, None);
    }

    #[test]
    fn unknown_api_latency_does_not_become_turn_latency() {
        let mut t = SessionTelemetry::new(&session());
        t.start_turn(Instant::now());
        t.record_api_response(&response("a", Some(30), None, None), None);
        assert_eq!(t.rolling_output_tokens(), Some(30));
        assert_eq!(t.rolling_api_duration(), None);
        assert_eq!(t.rolling_tokens_per_second(), None);
        assert_eq!(t.turn_api_count, 1);
    }

    #[test]
    fn resets_model_counters_but_preserves_session_usage_on_switch() {
        let mut s = session();
        let mut t = SessionTelemetry::new(&s);
        t.record_api_response(
            &response("old", Some(7), Some(9), Some(1)),
            Some(Duration::from_secs(1)),
        );
        let switched = serde_json::json!({
            "model_name": "new", "temperature": null, "max_tokens": null,
            "toolshim": false, "toolshim_model": null
        });
        s.model_config = Some(serde_json::from_value(switched).unwrap());
        s.accumulated_usage = Usage::new(Some(500), Some(25), Some(525));
        t.refresh_session(&s);
        assert_eq!(t.rolling_output_tokens(), None);
        assert_eq!(t.cache_read_for_model, None);
        assert_eq!(t.accumulated_usage.total_tokens, Some(525));
        assert_eq!(t.context_limit, None);
    }

    #[test]
    fn reported_cost_requires_complete_attribution_and_status_is_sanitized() {
        let mut t = SessionTelemetry::new(&session());
        let mut reported = response("a", Some(2), None, None);
        reported.cost = Some(0.15);
        reported.cost_source = Some(CostSource::ProviderReported);
        t.record_api_response(&reported, Some(Duration::from_secs(1)));
        assert_eq!(t.turn_cost_usd, Some(0.15));
        t.record_api_response(&response("a", Some(2), None, None), None);
        assert_eq!(t.turn_cost_usd, None);
        t.set_git_branch(Some("branch\u{1b}[31m\npoison".into()));
        assert!(!t.status_bar(Utc::now()).contains('\n'));
        assert!(!t.status_bar(Utc::now()).contains('\u{1b}'));
    }

    #[test]
    fn cache_ratio_uses_inclusive_prompt_and_requires_complete_reporting() {
        let mut t = SessionTelemetry::new(&session());
        t.record_api_response(&response("gemini", Some(10), Some(86), None), None);
        assert_eq!(t.cache_hit_pct(), Some(86.0));
        t.record_api_response(&response("gemini", Some(10), None, None), None);
        assert_eq!(t.cache_hit_pct(), None);
    }

    #[test]
    fn tool_requests_are_deduplicated_and_paths_observed() {
        let mut t = SessionTelemetry::new(&session());
        t.start_turn(Instant::now());
        let args = serde_json::json!({"path":"src/main.rs"});
        t.record_tool_request("id1", "developer__read_file", args.as_object());
        t.record_tool_request("id1", "developer__read_file", args.as_object());
        t.record_tool_request("id2", "developer__patch", args.as_object());
        assert_eq!(t.observed_tool_ids.len(), 2);
        assert!(t.turn_summary(Instant::now()).contains("2 files"));
        assert!(!t.turn_summary(Instant::now()).contains('\n'));
    }

    #[test]
    fn rolling_window_and_explicit_zero_counts() {
        let mut s = session();
        s.usage = Usage::new(Some(0), Some(0), Some(0));
        s.accumulated_usage = Usage::new(Some(0), Some(0), Some(0));
        let mut t = SessionTelemetry::new(&s);
        t.set_context_limit(Some(400));
        t.set_background_jobs(Some(0));
        t.set_compaction_count(Some(0));
        t.observe_compaction();
        for index in 1..=9 {
            t.record_api_response(
                &response("model", Some(index), None, None),
                Some(Duration::from_secs(1)),
            );
        }
        assert_eq!(t.rolling_output_tokens(), Some(5));
        assert_eq!(t.rolling_api_duration(), Some(Duration::from_secs(1)));
        assert_eq!(t.rolling_tokens_per_second(), Some(5.5));
        let report = t.usage_report(Utc::now());
        assert!(report.contains("Context (current snapshot): 0 / 400 tokens"));
        assert!(report.contains("Background jobs: 0"));
        assert!(report.contains("Compactions: 1"));
        assert!(report.contains("last 8 responses"));
    }
}
