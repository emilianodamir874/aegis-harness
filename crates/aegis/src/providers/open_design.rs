use aegis_providers::api_client::{ApiClient, AuthMethod, TlsConfig};
use aegis_providers::base::{
    ConfigKey, MessageStream, ModelInfo, Provider, ProviderDescriptor, ProviderMetadata,
};
use aegis_providers::errors::ProviderError;
use aegis_providers::formats::openai::{create_request_with_options, OpenAiFormatOptions};
use aegis_providers::images::ImageFormat;
use aegis_providers::model::ModelConfig;
use aegis_providers::openai_compatible::{handle_status, stream_openai_compat};
use aegis_providers::request_log::{start_log, LoggerHandleExt};
use aegis_providers::retry::ProviderRetry;
use aegis_providers::thinking::ThinkingEffort;
use anyhow::{bail, Result};
use async_trait::async_trait;
use futures::future::BoxFuture;
use rmcp::model::Tool;
use serde_json::{json, Value};
use std::time::Duration;

use super::base::ProviderDef;
use crate::config::{Config, ExtensionConfig};
use crate::conversation::message::Message;
use crate::providers::catalog::{
    ProviderSetupCategory, ProviderSetupGroup, ProviderSetupMetadata, ProviderSetupMethod,
};

pub const PROVIDER_NAME: &str = "open_design";
pub const BASE_URL: &str = "https://amr-link.open-design.ai/v1";
pub const MODEL: &str = "deepseek-v4.1-flash";
/// Second model family served by the same Open Design Chat Completions endpoint. The
/// effort aliases are local: every request carries the base id on the wire.
pub const GLM_MODEL: &str = "glm-5.3-flash";

/// Idle timeout for the streaming connection. reqwest reads this as the maximum gap
/// between reads, not total request time, so it only fires when the endpoint goes
/// silent. The shared 600s default turned a dead stream into a ten-minute hang
/// (observed max elapsed 606.9s, sitting on the timeout). The longest legitimate
/// silence measured is a 147.6s time-to-first-token, so 300s keeps 2x headroom
/// while halving the worst case.
pub const STREAM_IDLE_TIMEOUT_SECS: u64 = 300;
const KNOWN_MODELS: &[&str] = &[MODEL, GLM_MODEL];

/// Declared context window per family. GLM-5.3 Flash does not publish its window on the
/// Open Design endpoint, so it gets a conservative 200k: if the real one is larger the only
/// cost is compacting a little earlier, while claiming 1M would let a request overrun.
fn context_limit_for(model_name: &str) -> usize {
    if model_name.starts_with("glm-") {
        200_000
    } else {
        1_048_576
    }
}

pub struct OpenDesignProvider {
    client: ApiClient,
}

impl ProviderDescriptor for OpenDesignProvider {
    fn metadata() -> ProviderMetadata {
        let models = KNOWN_MODELS
            .iter()
            .map(|name| {
                let mut info = ModelInfo::new(*name)
                    .with_context_limit(context_limit_for(name))
                    .with_vision_support(true);
                info.reasoning = !name.ends_with("-none");
                info
            })
            .collect();
        ProviderMetadata::with_models(
            PROVIDER_NAME,
            "Open Design",
            "DeepSeek V4.1 Flash and GLM-5.3 Flash via Open Design Chat Completions",
            MODEL,
            models,
            "https://open-design.ai/cloud/workspace/models",
            vec![ConfigKey::new(
                "OPEN_DESIGN_API_KEY",
                true,
                true,
                None,
                true,
            )],
        )
        .with_setup(
            ProviderSetupMetadata::new(
                ProviderSetupCategory::Model,
                ProviderSetupMethod::ConfigFields,
                ProviderSetupGroup::Additional,
            )
            .with_docs_url("https://open-design.ai/cloud/api-keys")
            .with_field(
                "OPEN_DESIGN_API_KEY",
                "API Key",
                Some("Paste your Open Design API key"),
                None,
            ),
        )
    }
}

/// Build the streaming client for this endpoint. One function so the bounded-idle
/// invariant is covered by the tests, which cannot call `from_env` (it needs a real
/// API key).
fn stream_client(
    base_url: String,
    key: String,
    tls_config: Option<TlsConfig>,
) -> Result<ApiClient> {
    Ok(ApiClient::with_timeout_and_tls(
        base_url,
        AuthMethod::BearerToken(key),
        Duration::from_secs(STREAM_IDLE_TIMEOUT_SECS),
        tls_config,
    )?
    .with_request_builder(crate::session_context::session_id_request_builder()))
}

impl ProviderDef for OpenDesignProvider {
    type Provider = Self;

    fn from_env(
        _extensions: Vec<ExtensionConfig>,
        tls_config: Option<TlsConfig>,
    ) -> BoxFuture<'static, Result<Self::Provider>> {
        Box::pin(async move {
            let key: String = Config::global().get_secret("OPEN_DESIGN_API_KEY")?;
            if key.trim().is_empty() {
                bail!("OPEN_DESIGN_API_KEY is empty; configure the Open Design provider first");
            }
            Ok(Self {
                client: stream_client(BASE_URL.to_string(), key, tls_config)?,
            })
        })
    }
}

/// Effort encoded in the model id (`-none`, `-low`, `-medium`, `-high`, `-max`). Before
/// v52 every effort was its own advertised model; the suffix stays supported only so old
/// sessions and saved configs keep working, and it is a *fallback*: the session's
/// `thinking_effort` option is the single source of truth.
fn legacy_suffix_effort(model_name: &str) -> Option<ThinkingEffort> {
    match model_name.rsplit('-').next()? {
        "none" => Some(ThinkingEffort::Off),
        "low" => Some(ThinkingEffort::Low),
        "medium" => Some(ThinkingEffort::Medium),
        "high" => Some(ThinkingEffort::High),
        "max" => Some(ThinkingEffort::Max),
        _ => None,
    }
}

/// Wire model for a selection: effort aliases are local, so every request carries the base
/// id of its own family.
fn wire_model(model_name: &str) -> &'static str {
    if model_name.starts_with("glm-") {
        GLM_MODEL
    } else {
        MODEL
    }
}

fn build_payload(
    model_config: &ModelConfig,
    system: &str,
    messages: &[Message],
    tools: &[Tool],
) -> Result<Value, ProviderError> {
    let configured_effort = model_config
        .thinking_effort()
        .or_else(|| legacy_suffix_effort(&model_config.model_name));
    // Selecting an effort alias in /model takes precedence over a saved global effort,
    // but an explicit off is authoritative: harness one-shot calls (compaction,
    // tool-pair summaries, titles) disable thinking, and letting the alias re-enable
    // max reasoning billed those reasoning tokens inside the summarizer's output
    // budget, which aborted every compaction with "filled the configured budget".
    let effort = configured_effort;
    let mut request_config = model_config.clone();
    request_config.model_name = wire_model(&model_config.model_name).to_string();
    request_config.supports_vision = Some(true);
    let mut payload = create_request_with_options(
        &request_config,
        system,
        messages,
        tools,
        &ImageFormat::OpenAi,
        true,
        OpenAiFormatOptions {
            preserve_thinking_context: true,
            supports_vision: true,
            ..Default::default()
        },
    )?;
    let object = payload.as_object_mut().ok_or_else(|| {
        ProviderError::RequestFailed("Open Design request must be a JSON object".into())
    })?;
    match effort {
        Some(ThinkingEffort::Off) => {
            object.insert("thinking".into(), json!({"type": "disabled"}));
            object.remove("reasoning_effort");
        }
        Some(ThinkingEffort::Low) => {
            object.insert("thinking".into(), json!({"type": "enabled"}));
            object.insert("reasoning_effort".into(), json!("low"));
        }
        Some(ThinkingEffort::Medium | ThinkingEffort::High) => {
            object.insert("thinking".into(), json!({"type": "enabled"}));
            object.insert("reasoning_effort".into(), json!("high"));
        }
        Some(ThinkingEffort::Max) => {
            object.insert("thinking".into(), json!({"type": "enabled"}));
            object.insert("reasoning_effort".into(), json!("max"));
        }
        None => {} // DeepSeek defaults to enabled/high.
    }
    Ok(payload)
}

#[async_trait]
impl Provider for OpenDesignProvider {
    fn get_name(&self) -> &str {
        PROVIDER_NAME
    }

    async fn get_context_limit(&self, model: &str, override_limit: Option<usize>) -> usize {
        override_limit.unwrap_or_else(|| context_limit_for(model))
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(KNOWN_MODELS.iter().map(|s| (*s).to_owned()).collect())
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let payload = build_payload(model_config, system, messages, tools)?;
        let mut log = start_log(model_config, &payload)?;
        let response = self
            .with_retry(|| async {
                handle_status(
                    self.client
                        .request("chat/completions")
                        .model_headers(model_config)?
                        .streaming(true)
                        .response_post(&payload)
                        .await?,
                )
                .await
            })
            .await
            .inspect_err(|error| {
                let _ = log.error(error);
            })?;
        stream_openai_compat(response, log)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn only_listed_models_are_exposed() {
        let metadata = OpenDesignProvider::metadata();
        assert_eq!(metadata.known_models.len(), 2);
        assert_eq!(metadata.default_model, MODEL);
        assert_eq!(metadata.config_keys.len(), 1);
        assert!(metadata.config_keys[0].secret);
        // Cualquier id entra: el esfuerzo ya no se valida desde el nombre (v52).
    }

    #[test]
    fn effort_comes_from_the_session_option() {
        for (effort, thinking, param) in [
            (None, None, None),
            (Some(ThinkingEffort::Off), Some("disabled"), None),
            (Some(ThinkingEffort::Low), Some("enabled"), Some("low")),
            (Some(ThinkingEffort::High), Some("enabled"), Some("high")),
            (Some(ThinkingEffort::Max), Some("enabled"), Some("max")),
        ] {
            let mut config = ModelConfig::new(GLM_MODEL);
            if let Some(effort) = effort {
                config = config.with_thinking_effort(effort);
            }
            let payload = build_payload(&config, "", &[], &[]).unwrap();
            assert_eq!(payload["model"], GLM_MODEL);
            assert_eq!(
                payload.get("thinking").map(|v| v["type"].as_str().unwrap()),
                thinking
            );
            assert_eq!(
                payload.get("reasoning_effort").and_then(Value::as_str),
                param
            );
            assert_eq!(payload["stream"], true);
            assert!(payload.get("service_tier").is_none());
        }
        let payload = build_payload(
            &ModelConfig::new(MODEL).with_thinking_effort(ThinkingEffort::Medium),
            "",
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(payload["reasoning_effort"], "high");
    }

    #[test]
    fn legacy_suffix_models_still_route_to_their_family() {
        for (legacy, wire) in [
            ("deepseek-v4.1-flash-none", MODEL),
            ("deepseek-v4.1-flash-max", MODEL),
            ("glm-5.3-flash-low", GLM_MODEL),
            ("glm-5.3-flash-high", GLM_MODEL),
        ] {
            let payload = build_payload(&ModelConfig::new(legacy), "", &[], &[]).unwrap();
            assert_eq!(payload["model"], wire, "{legacy}");
        }
        let off = build_payload(&ModelConfig::new("glm-5.3-flash-none"), "", &[], &[]).unwrap();
        assert_eq!(off["thinking"], json!({"type": "disabled"}));
        // El chip manda sobre el sufijo heredado.
        let chip = build_payload(
            &ModelConfig::new("glm-5.3-flash-max").with_thinking_effort(ThinkingEffort::Low),
            "",
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(chip["reasoning_effort"], "low");
    }

    #[test]
    fn an_explicit_thinking_off_survives_an_effort_alias() {
        let payload = build_payload(
            &ModelConfig::new("deepseek-v4.1-flash-max").with_thinking_effort(ThinkingEffort::Off),
            "",
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(payload["thinking"], json!({"type": "disabled"}));
        assert!(payload.get("reasoning_effort").is_none());
    }

    #[tokio::test]
    async fn streams_openai_sse_with_bearer_auth_and_effort() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-only-key"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                concat!(
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hola\"},\"finish_reason\":null}],\"model\":\"deepseek-v4.1-flash\"}\n\n",
                    "data: [DONE]\n\n",
                ),
                "text/event-stream",
            ))
            .mount(&server)
            .await;
        let provider = OpenDesignProvider {
            client: stream_client(server.uri() + "/v1", "test-only-key".into(), None).unwrap(),
        };
        let mut stream = provider
            .stream(&ModelConfig::new("deepseek-v4.1-flash-max"), "", &[], &[])
            .await
            .unwrap();
        let mut text = String::new();
        while let Some(item) = stream.next().await {
            let (message, _) = item.unwrap();
            if let Some(message) = message {
                for content in message.content {
                    text.push_str(&content.to_string());
                }
            }
        }
        assert_eq!(text, "hola");
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["reasoning_effort"], "max");
    }

    #[test]
    fn stream_client_uses_a_bounded_idle_timeout() {
        let client = stream_client("https://example.invalid/v1".into(), "k".into(), None).unwrap();
        assert_eq!(
            client.timeout(),
            Duration::from_secs(STREAM_IDLE_TIMEOUT_SECS)
        );
        assert!(
            STREAM_IDLE_TIMEOUT_SECS < 600,
            "must stay tighter than the shared provider default"
        );
    }
}
