use crate::agents::Agent;
use crate::conversation::message::{
    Message, MessageContent, ToolChainSummary, ToolRequest, TOOL_META_CHAIN_SUMMARY_KEY,
    TOOL_META_TITLE_KEY,
};
use crate::providers::base::Provider;
use crate::session::SessionManager;
use crate::utils::safe_truncate;
use aegis_providers::model::ModelConfig;
use serde_json::json;
use std::slice::from_ref;
use std::time::Duration;
use tokio::time::sleep;
use tracing::warn;

/// El titulo de una tool call es un detalle de UI y se arma localmente: generarlo con el
/// modelo costaba una ida y vuelta al proveedor por cada tool call (medido: 38 % de los
/// requests de un turno con herramientas eran estos one-shots). El texto sale del nombre y
/// los argumentos, asi que es instantaneo y determinista.
const LOCAL_TITLE_MAX_CHARS: usize = 60;
const LOCAL_TITLE_MAX_WORDS: usize = 10;
const TOOL_CHAIN_SUMMARY_SYSTEM_PROMPT: &str =
    "Summarize this sequence of tool calls in a short lowercase phrase \
     (3-8 words). No punctuation. No quotes. \
     Examples: applied dark mode polish, scanned for security issues, \
     refactored config loading. Reply with the phrase only.";
const TOOL_CHAIN_ARGUMENTS_MAX_LENGTH: usize = 200;
/// Un label util es corto y de una linea. El modelo a veces responde con parrafos
/// ("no tengo herramienta de shell...") cuando los argumentos le llegan cortados, y ese
/// texto se persistia como titulo del paso y se mostraba en la UI.
const LABEL_MAX_CHARS: usize = 60;
const LABEL_MAX_WORDS: usize = 10;
const LABEL_GENERATION_MAX_ATTEMPTS: usize = 2;
const LABEL_GENERATION_RETRY_DELAY: Duration = Duration::from_millis(150);

pub(crate) async fn generate_tool_title(
    session_manager: &SessionManager,
    session_id: &str,
    tool_request: &ToolRequest,
) -> Option<String> {
    let title = local_tool_title(tool_request)?;
    let request_id = &tool_request.id;

    let patch = json!({
        (TOOL_META_TITLE_KEY): &title,
    });
    if let Err(error) = session_manager
        .update_tool_request_meta(session_id, request_id, patch)
        .await
    {
        warn!("tool call title: persist failed for {request_id}: {error}");
    }

    Some(title)
}

/// Nombre corto de herramienta, verbo en gerundio y el argumento que identifica la llamada.
/// `developer__shell` con `{"command": "git status"}` produce `running git status`.
fn local_tool_title(tool_request: &ToolRequest) -> Option<String> {
    let tool_call = tool_request.tool_call.as_ref().ok()?;
    let name = tool_call.name.as_ref();
    let short_name = name.rsplit("__").next().unwrap_or(name);
    let target = salient_argument(tool_call.arguments.as_ref());
    let label = match (verb_for(short_name), target) {
        (Some(verb), Some(target)) => format!("{verb} {target}"),
        (Some(verb), None) => verb.to_string(),
        (None, Some(target)) => format!("{} {target}", short_name.replace('_', " ")),
        (None, None) => short_name.replace('_', " "),
    };
    finish_local_title(&label)
}

fn verb_for(tool_name: &str) -> Option<&'static str> {
    Some(match tool_name {
        "shell" | "run" | "exec" | "execute_command" => "running",
        "read_file" | "read" => "reading",
        "write" | "write_file" => "writing",
        "edit" | "apply_patch" | "str_replace" => "editing",
        "grep" | "search" => "searching",
        "tree" | "list" | "list_files" => "listing",
        "web_search" => "searching the web for",
        "web_fetch" => "fetching",
        "read_image" => "looking at",
        "load" | "load_skill" => "loading",
        "delegate" => "delegating",
        "chatrecall" => "searching past chats for",
        "memory_write" => "saving memory",
        "memory_search" => "searching memory for",
        "memory_list" => "listing memory",
        "memory_confirm" => "confirming memory",
        "memory_forget" => "forgetting memory",
        "memory_consolidate" => "consolidating memory",
        "manage_extensions" => "changing extensions",
        "search_available_extensions" => "searching extensions",
        "manage_schedule" => "editing the schedule",
        _ => return None,
    })
}

/// El argumento que mejor identifica una llamada, en orden de utilidad para el operador.
fn salient_argument(
    arguments: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    const PRIORITY: [&str; 9] = [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "prompt",
        "skill",
        "name",
    ];
    const PATH_KEYS: [&str; 2] = ["path", "file_path"];

    let arguments = arguments?;
    for key in PRIORITY {
        let Some(value) = arguments.get(key).and_then(serde_json::Value::as_str) else {
            continue;
        };
        let value = collapse_whitespace(value);
        if value.is_empty() {
            continue;
        }
        return Some(if PATH_KEYS.contains(&key) {
            shorten_path(&value)
        } else {
            value
        });
    }
    arguments
        .values()
        .filter_map(serde_json::Value::as_str)
        .map(collapse_whitespace)
        .find(|value| !value.is_empty())
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn shorten_path(value: &str) -> String {
    let parts: Vec<&str> = value
        .split(['\\', '/'])
        .filter(|part| !part.is_empty())
        .collect();
    match parts.len() {
        0 | 1 => value.to_string(),
        len => format!("{}/{}", parts[len - 2], parts[len - 1]),
    }
}

fn finish_local_title(label: &str) -> Option<String> {
    let collapsed = collapse_whitespace(label);
    if collapsed.is_empty() {
        return None;
    }
    let words: Vec<&str> = collapsed.split(' ').take(LOCAL_TITLE_MAX_WORDS).collect();
    let bounded = safe_truncate(&words.join(" "), LOCAL_TITLE_MAX_CHARS);
    let bounded = bounded.trim().to_string();
    label_is_usable(&bounded).then_some(bounded)
}

pub(crate) async fn generate_tool_chain_summary(
    agent: &Agent,
    session_manager: &SessionManager,
    session_id: &str,
    tool_requests: &[ToolRequest],
) -> Option<ToolChainSummary> {
    let steps = prepare_tool_chain_steps(tool_requests);
    if steps.len() < 2 {
        return None;
    }

    let provider = agent.provider(session_id).await.ok()?;
    if provider.manages_own_context() {
        return None;
    }

    let model_config = agent.model_config_for_session(session_id).await.ok()?;
    let chain_summary = ToolChainSummary {
        summary: generate_tool_chain_summary_with_provider(
            provider.as_ref(),
            &model_config,
            session_id,
            &steps,
        )
        .await?,
        count: tool_requests.len(),
    };
    let first_tool_call_id = &tool_requests.first()?.id;
    let patch = json!({
        (TOOL_META_CHAIN_SUMMARY_KEY): &chain_summary,
    });
    if let Err(error) = session_manager
        .update_tool_request_meta(session_id, first_tool_call_id, patch)
        .await
    {
        warn!(
            "tool chain summary: persist failed for chain anchored at {first_tool_call_id}: {error}",
        );
    }

    Some(chain_summary)
}

fn prepare_tool_chain_steps(tool_requests: &[ToolRequest]) -> Vec<(String, String)> {
    tool_requests
        .iter()
        .filter_map(|request| {
            let tool_call = request.tool_call.as_ref().ok()?;
            let arguments = tool_call
                .arguments
                .as_ref()
                .map(|arguments| {
                    let serialized = serde_json::to_string(arguments).unwrap_or_default();
                    if serialized.len() > TOOL_CHAIN_ARGUMENTS_MAX_LENGTH {
                        format!(
                            "{}…",
                            safe_truncate(&serialized, TOOL_CHAIN_ARGUMENTS_MAX_LENGTH)
                        )
                    } else {
                        serialized
                    }
                })
                .unwrap_or_default();
            Some((tool_call.name.to_string(), arguments))
        })
        .collect()
}

async fn generate_tool_chain_summary_with_provider(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    steps: &[(String, String)],
) -> Option<String> {
    let mut user_text = String::from("Tool call sequence:\n");
    for (index, (name, args)) in steps.iter().enumerate() {
        user_text.push_str(&format!("Step {}: {} {}\n", index + 1, name, args));
    }
    let message = Message::user().with_text(user_text);

    complete_label(
        provider,
        model_config,
        session_id,
        TOOL_CHAIN_SUMMARY_SYSTEM_PROMPT,
        &message,
    )
    .await
}

async fn complete_label(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    system_prompt: &str,
    message: &Message,
) -> Option<String> {
    for attempt in 0..LABEL_GENERATION_MAX_ATTEMPTS {
        if let Ok((response, _)) = crate::model_config::complete_one_shot(
            provider,
            model_config,
            session_id,
            system_prompt,
            from_ref(message),
            &[],
        )
        .await
        {
            let label = response
                .content
                .iter()
                .filter_map(MessageContent::as_text)
                .collect::<String>()
                .trim()
                .to_string();
            if label_is_usable(&label) {
                return Some(label);
            }
        }

        if attempt + 1 < LABEL_GENERATION_MAX_ATTEMPTS {
            sleep(LABEL_GENERATION_RETRY_DELAY).await;
        }
    }

    None
}

fn label_is_usable(label: &str) -> bool {
    !label.is_empty()
        && !label.contains('\n')
        && label.len() <= LABEL_MAX_CHARS
        && label.split_whitespace().count() <= LABEL_MAX_WORDS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{AegisPlatform, AgentConfig};
    use crate::config::{AegisMode, PermissionManager};
    use crate::providers::base::{MessageStream, ProviderUsage, Usage};
    use crate::session::{SessionManager, SessionType};
    use aegis_providers::errors::ProviderError;
    use async_trait::async_trait;
    use rmcp::model::{CallToolRequestParams, ErrorData, Tool};
    use serde_json::json;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    struct MockProvider {
        outcomes: Mutex<VecDeque<Result<Message, ProviderError>>>,
        calls: AtomicUsize,
        messages: Mutex<Vec<Vec<Message>>>,
        model_configs: Mutex<Vec<ModelConfig>>,
        manages_own_context: bool,
    }

    impl MockProvider {
        fn new(outcomes: Vec<Result<Message, ProviderError>>) -> Self {
            Self {
                outcomes: Mutex::new(outcomes.into()),
                calls: AtomicUsize::new(0),
                messages: Mutex::new(Vec::new()),
                model_configs: Mutex::new(Vec::new()),
                manages_own_context: false,
            }
        }

        fn managing_own_context() -> Self {
            Self {
                outcomes: Mutex::new(VecDeque::new()),
                calls: AtomicUsize::new(0),
                messages: Mutex::new(Vec::new()),
                model_configs: Mutex::new(Vec::new()),
                manages_own_context: true,
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn first_user_message(&self) -> String {
            self.messages.lock().unwrap()[0][0].as_concat_text()
        }
    }

    #[async_trait]
    impl Provider for MockProvider {
        fn get_name(&self) -> &str {
            "tool-title-test"
        }

        async fn stream(
            &self,
            _model_config: &ModelConfig,
            _system: &str,
            _messages: &[Message],
            _tools: &[Tool],
        ) -> Result<MessageStream, ProviderError> {
            unreachable!("title generation calls complete directly")
        }

        async fn complete(
            &self,
            model_config: &ModelConfig,
            _system: &str,
            messages: &[Message],
            _tools: &[Tool],
        ) -> Result<(Message, ProviderUsage), ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.messages.lock().unwrap().push(messages.to_vec());
            self.model_configs
                .lock()
                .unwrap()
                .push(model_config.clone());
            let outcome = self
                .outcomes
                .lock()
                .unwrap()
                .pop_front()
                .expect("test provider should have a configured outcome");
            outcome.map(|message| {
                (
                    message,
                    ProviderUsage::new("tool-title-test".to_string(), Usage::default()),
                )
            })
        }

        fn manages_own_context(&self) -> bool {
            self.manages_own_context
        }
    }

    fn tool_request(arguments: serde_json::Value) -> ToolRequest {
        tool_request_with("request-1", "developer__shell", arguments)
    }

    fn tool_request_with(id: &str, name: &str, arguments: serde_json::Value) -> ToolRequest {
        ToolRequest {
            id: id.to_string(),
            tool_call: Ok(CallToolRequestParams::new(name.to_string())
                .with_arguments(arguments.as_object().unwrap().clone())),
            metadata: None,
            tool_meta: None,
        }
    }

    fn invalid_tool_request(id: &str) -> ToolRequest {
        ToolRequest {
            id: id.to_string(),
            tool_call: Err(ErrorData::invalid_request("invalid tool call", None)),
            metadata: None,
            tool_meta: None,
        }
    }

    async fn generate_chain_with(
        provider: &MockProvider,
        steps: &[(String, String)],
    ) -> Option<String> {
        generate_tool_chain_summary_with_provider(
            provider,
            &ModelConfig::new("test-model"),
            "session-1",
            steps,
        )
        .await
    }

    fn chain_steps() -> Vec<(String, String)> {
        vec![
            (
                "developer__read".to_string(),
                "{\"path\":\"src\"}".to_string(),
            ),
            (
                "developer__shell".to_string(),
                "{\"command\":\"cargo test\"}".to_string(),
            ),
        ]
    }

    fn chain_tool_requests() -> Vec<ToolRequest> {
        vec![
            tool_request_with("request-1", "developer__read", json!({"path": "src"})),
            tool_request_with(
                "request-2",
                "developer__shell",
                json!({"command": "cargo test"}),
            ),
        ]
    }

    mod title_generation {
        use super::*;

        fn title_of(name: &str, arguments: serde_json::Value) -> Option<String> {
            local_tool_title(&tool_request_with("request-1", name, arguments))
        }

        #[test]
        fn labels_a_shell_call_with_its_command() {
            assert_eq!(
                title_of("developer__shell", json!({"command": "git status"})).as_deref(),
                Some("running git status"),
            );
        }

        #[test]
        fn labels_a_read_with_the_last_two_path_components() {
            assert_eq!(
                title_of(
                    "developer__read_file",
                    json!({"path": "C:/Aegis-Proyects/src/crates/aegis/src/lib.rs"}),
                )
                .as_deref(),
                Some("reading src/lib.rs"),
            );
        }

        #[test]
        fn unknown_tools_fall_back_to_their_own_name() {
            assert_eq!(
                title_of("custom_tool", json!({"name": "alpha"})).as_deref(),
                Some("custom tool alpha"),
            );
        }

        #[test]
        fn labels_stay_on_one_bounded_line() {
            let command = format!("powershell -NoProfile -Command \"{}\"", "x".repeat(400));
            let title = title_of("developer__shell", json!({"command": command}))
                .expect("a shell call always yields a label");

            assert!(!title.contains('\n'));
            assert!(title.chars().count() <= LOCAL_TITLE_MAX_CHARS);
            assert!(title.split_whitespace().count() <= LOCAL_TITLE_MAX_WORDS);
        }

        #[test]
        fn labels_are_deterministic() {
            let arguments = json!({"command": "cargo test -p aegis --lib"});
            assert_eq!(
                title_of("developer__shell", arguments.clone()),
                title_of("developer__shell", arguments),
            );
        }

        #[test]
        fn a_broken_tool_call_has_no_label() {
            assert_eq!(local_tool_title(&invalid_tool_request("request-1")), None);
        }

        #[tokio::test]
        async fn persists_local_title_without_calling_a_provider() {
            let temp_dir = TempDir::new().unwrap();
            let session_manager = Arc::new(SessionManager::new(temp_dir.path().join("sessions")));
            let session = session_manager
                .create_session(
                    PathBuf::new(),
                    "test".to_string(),
                    SessionType::Hidden,
                    AegisMode::Auto,
                )
                .await
                .unwrap();
            let tool_request = tool_request(json!({"command": "git status"}));
            let message = Message::assistant()
                .with_id("message-1")
                .with_tool_request(tool_request.id.clone(), tool_request.tool_call.clone());
            session_manager
                .add_message(&session.id, &message)
                .await
                .unwrap();

            let title =
                generate_tool_title(session_manager.as_ref(), &session.id, &tool_request).await;

            assert_eq!(title.as_deref(), Some("running git status"));
            let loaded = session_manager
                .get_session(&session.id, true)
                .await
                .unwrap();
            let persisted_title = loaded
                .conversation
                .as_ref()
                .unwrap()
                .messages()
                .iter()
                .flat_map(|message| &message.content)
                .find_map(|content| match content {
                    MessageContent::ToolRequest(request) if request.id == "request-1" => {
                        request.generated_title()
                    }
                    _ => None,
                });

            assert_eq!(persisted_title, Some("running git status"));
        }
    }

    mod chain_summary_generation {
        use super::*;

        #[test]
        fn prepares_valid_requests_in_order_and_ignores_invalid_requests() {
            let mut requests = chain_tool_requests();
            requests.insert(1, invalid_tool_request("invalid-request"));

            assert_eq!(prepare_tool_chain_steps(&requests), chain_steps());
        }

        #[test]
        fn truncates_long_serialized_arguments() {
            let arguments = json!({"command": "x".repeat(400)});
            let serialized = serde_json::to_string(arguments.as_object().unwrap()).unwrap();
            let requests = vec![tool_request_with(
                "request-1",
                "developer__shell",
                arguments,
            )];

            assert_eq!(
                prepare_tool_chain_steps(&requests),
                vec![(
                    "developer__shell".to_string(),
                    format!(
                        "{}…",
                        safe_truncate(&serialized, TOOL_CHAIN_ARGUMENTS_MAX_LENGTH)
                    ),
                )],
            );
        }

        #[tokio::test]
        async fn preserves_step_order_and_trims_result() {
            let provider = MockProvider::new(vec![Ok(
                Message::assistant().with_text("  inspected and tested project  ")
            )]);

            let summary = generate_chain_with(&provider, &chain_steps()).await;

            assert_eq!(summary.as_deref(), Some("inspected and tested project"));
            assert_eq!(provider.call_count(), 1);
            assert_eq!(
                provider.first_user_message(),
                "Tool call sequence:\nStep 1: developer__read {\"path\":\"src\"}\nStep 2: developer__shell {\"command\":\"cargo test\"}\n",
            );
        }

        #[tokio::test]
        async fn retries_once_after_empty_response() {
            let provider = MockProvider::new(vec![
                Ok(Message::assistant().with_text("")),
                Ok(Message::assistant().with_text("inspected and tested project")),
            ]);

            let summary = generate_chain_with(&provider, &chain_steps()).await;

            assert_eq!(summary.as_deref(), Some("inspected and tested project"));
            assert_eq!(provider.call_count(), 2);
        }

        #[tokio::test]
        async fn retries_once_after_provider_error() {
            let provider = MockProvider::new(vec![
                Err(ProviderError::ExecutionError("temporary".to_string())),
                Ok(Message::assistant().with_text("inspected and tested project")),
            ]);

            let summary = generate_chain_with(&provider, &chain_steps()).await;

            assert_eq!(summary.as_deref(), Some("inspected and tested project"));
            assert_eq!(provider.call_count(), 2);
        }

        #[tokio::test]
        async fn returns_none_after_two_unsuccessful_attempts() {
            let provider = MockProvider::new(vec![
                Ok(Message::assistant().with_text("")),
                Err(ProviderError::ExecutionError(
                    "still unavailable".to_string(),
                )),
            ]);

            let summary = generate_chain_with(&provider, &chain_steps()).await;

            assert_eq!(summary, None);
            assert_eq!(provider.call_count(), 2);
        }

        #[tokio::test]
        async fn skips_provider_that_manages_own_context() {
            let temp_dir = TempDir::new().unwrap();
            let session_manager = Arc::new(SessionManager::new(temp_dir.path().join("sessions")));
            let permission_manager =
                Arc::new(PermissionManager::new(temp_dir.path().join("permissions")));
            let agent = Agent::with_config(AgentConfig::new(
                session_manager.clone(),
                permission_manager,
                None,
                true,
                AegisPlatform::AegisCli,
            ));
            let session = session_manager
                .create_session(
                    PathBuf::new(),
                    "test".to_string(),
                    SessionType::Hidden,
                    AegisMode::Auto,
                )
                .await
                .unwrap();
            let provider = Arc::new(MockProvider::managing_own_context());
            agent
                .update_provider(
                    provider.clone(),
                    ModelConfig::new("test-model"),
                    &session.id,
                )
                .await
                .unwrap();

            let summary = generate_tool_chain_summary(
                &agent,
                session_manager.as_ref(),
                &session.id,
                &chain_tool_requests(),
            )
            .await;

            assert_eq!(summary, None);
            assert_eq!(provider.call_count(), 0);
        }

        #[tokio::test]
        async fn requires_two_usable_requests_before_provider_completion() {
            let temp_dir = TempDir::new().unwrap();
            let session_manager = Arc::new(SessionManager::new(temp_dir.path().join("sessions")));
            let permission_manager =
                Arc::new(PermissionManager::new(temp_dir.path().join("permissions")));
            let agent = Agent::with_config(AgentConfig::new(
                session_manager.clone(),
                permission_manager,
                None,
                true,
                AegisPlatform::AegisCli,
            ));
            let session = session_manager
                .create_session(
                    PathBuf::new(),
                    "test".to_string(),
                    SessionType::Hidden,
                    AegisMode::Auto,
                )
                .await
                .unwrap();
            let provider = Arc::new(MockProvider::new(Vec::new()));
            agent
                .update_provider(
                    provider.clone(),
                    ModelConfig::new("test-model"),
                    &session.id,
                )
                .await
                .unwrap();

            let summary = generate_tool_chain_summary(
                &agent,
                session_manager.as_ref(),
                &session.id,
                &[tool_request(json!({}))],
            )
            .await;

            assert_eq!(summary, None);
            assert_eq!(provider.call_count(), 0);
        }

        #[tokio::test]
        async fn persists_summary_and_tool_call_count_on_first_request() {
            let temp_dir = TempDir::new().unwrap();
            let session_manager = Arc::new(SessionManager::new(temp_dir.path().join("sessions")));
            let permission_manager =
                Arc::new(PermissionManager::new(temp_dir.path().join("permissions")));
            let agent = Agent::with_config(AgentConfig::new(
                session_manager.clone(),
                permission_manager,
                None,
                true,
                AegisPlatform::AegisCli,
            ));
            let session = session_manager
                .create_session(
                    PathBuf::new(),
                    "test".to_string(),
                    SessionType::Hidden,
                    AegisMode::Auto,
                )
                .await
                .unwrap();
            let provider = Arc::new(MockProvider::new(vec![Ok(
                Message::assistant().with_text("inspected and tested project")
            )]));
            agent
                .update_provider(provider, ModelConfig::new("test-model"), &session.id)
                .await
                .unwrap();
            let tool_requests = chain_tool_requests();
            let message = Message::assistant()
                .with_id("message-1")
                .with_tool_request(
                    tool_requests[0].id.clone(),
                    tool_requests[0].tool_call.clone(),
                )
                .with_tool_request(
                    tool_requests[1].id.clone(),
                    tool_requests[1].tool_call.clone(),
                );
            session_manager
                .add_message(&session.id, &message)
                .await
                .unwrap();

            let summary = generate_tool_chain_summary(
                &agent,
                session_manager.as_ref(),
                &session.id,
                &tool_requests,
            )
            .await;

            assert_eq!(
                summary,
                Some(ToolChainSummary {
                    summary: "inspected and tested project".to_string(),
                    count: tool_requests.len(),
                }),
            );
            let loaded = session_manager
                .get_session(&session.id, true)
                .await
                .unwrap();
            let persisted_summary = loaded
                .conversation
                .as_ref()
                .unwrap()
                .messages()
                .iter()
                .flat_map(|message| &message.content)
                .find_map(|content| match content {
                    MessageContent::ToolRequest(request) if request.id == tool_requests[0].id => {
                        request.generated_chain_summary()
                    }
                    _ => None,
                })
                .unwrap();

            assert_eq!(persisted_summary.summary, "inspected and tested project");
            assert_eq!(persisted_summary.count, tool_requests.len());
        }
    }
}
