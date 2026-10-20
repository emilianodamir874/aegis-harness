use aegis_providers::api_client::{ApiClient, AuthMethod, AuthProvider, TlsConfig};
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
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use futures::future::BoxFuture;
use rmcp::model::Tool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

use super::base::ProviderDef;
use crate::config::{Config, ExtensionConfig};
use crate::conversation::message::Message;
use crate::providers::catalog::{
    ProviderSetupCategory, ProviderSetupGroup, ProviderSetupMetadata, ProviderSetupMethod,
};
use crate::providers::private_file::write_private_file;

pub const PROVIDER_NAME: &str = "opencode_go";
pub const BASE_URL: &str = "https://opencode.ai/inference/go/openai/v1";
pub const MODEL: &str = "deepseek-v4.1-flash";
const CONSOLE_URL: &str = "https://opencode.ai/console";
const REFRESH_SKEW_MS: u64 = 120_000;
const DEEPSEEK_FLASH_CONTEXT_LIMIT: usize = 1_000_000;
const DEFAULT_CONTEXT_LIMIT: usize = 200_000;

fn context_limit_for(model: &str) -> usize {
    if model == MODEL {
        DEEPSEEK_FLASH_CONTEXT_LIMIT
    } else {
        DEFAULT_CONTEXT_LIMIT
    }
}
const CHAT_MODELS: &[&str] = &[
    MODEL,
    "deepseek-v4-pro",
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "kimi-k3",
    "kimi-k2.7-code",
    "longcat-2.0",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "hy4-preview",
    "hy3",
    "minimax-m3.1-flash-free",
    "longcat-2.5-preview-free",
    "step-5-preview",
    "beam-free",
];

pub struct OpenCodeGoProvider {
    client: ApiClient,
}

impl ProviderDescriptor for OpenCodeGoProvider {
    fn metadata() -> ProviderMetadata {
        let models = CHAT_MODELS
            .iter()
            .map(|name| ModelInfo::new(*name).with_context_limit(context_limit_for(name)))
            .collect();
        ProviderMetadata::with_models(
            PROVIDER_NAME,
            "OpenCode Go",
            "OpenCode Go subscription models (OpenAI Chat Completions endpoint)",
            MODEL,
            models,
            "https://opencode.ai/docs/go/",
            vec![ConfigKey::new(
                "OPENCODE_GO_API_KEY",
                false,
                true,
                None,
                false,
            )],
        )
        .with_setup_steps(vec!["Sign in with OpenCode CLI first; Aegis reuses its Console login. An API key can be supplied as an optional override."])
        .with_setup(
            ProviderSetupMetadata::new(
                ProviderSetupCategory::Model,
                ProviderSetupMethod::CliAuth,
                ProviderSetupGroup::Additional,
            )
            .with_docs_url("https://opencode.ai/docs/go/")
            .with_field(
                "OPENCODE_GO_API_KEY",
                "API Key",
                Some("Optional: Console API key. Otherwise uses OpenCode CLI login."),
                None,
            ),
        )
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct CliOAuth {
    #[serde(rename = "type")]
    kind: String,
    access: String,
    refresh: String,
    expires: u64,
}

#[derive(Deserialize)]
struct RefreshedToken {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

fn cli_auth_path() -> Result<PathBuf> {
    if let Some(data) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(data).join("opencode/auth.json"));
    }
    let home =
        dirs::home_dir().ok_or_else(|| anyhow!("Cannot find OpenCode CLI home directory"))?;
    Ok(home.join(".local/share/opencode/auth.json"))
}

fn read_cli_oauth(path: &Path) -> Result<CliOAuth> {
    let data: Value = serde_json::from_slice(
        &std::fs::read(path)
            .with_context(|| format!("OpenCode CLI login missing at {}", path.display()))?,
    )?;
    let oauth: CliOAuth = serde_json::from_value(
        data.get("opencode")
            .ok_or_else(|| {
                anyhow!("OpenCode CLI login missing; sign in to OpenCode Console first")
            })?
            .clone(),
    )?;
    if oauth.kind != "oauth" || oauth.access.is_empty() || oauth.refresh.is_empty() {
        bail!("OpenCode CLI login is not a usable OAuth credential");
    }
    Ok(oauth)
}

pub(crate) fn cli_login_available() -> bool {
    cli_auth_path().is_ok_and(|path| read_cli_oauth(&path).is_ok())
}

fn now_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

struct CliAuth {
    path: PathBuf,
    refresh_url: String,
    client: reqwest::Client,
    mutex: Mutex<()>,
}

impl CliAuth {
    fn new(path: PathBuf, tls_config: Option<&TlsConfig>) -> Result<Self> {
        Ok(Self {
            path,
            refresh_url: format!("{CONSOLE_URL}/auth/device/token"),
            client: ApiClient::http_client(tls_config)?,
            mutex: Mutex::new(()),
        })
    }

    async fn token(&self, force: bool) -> Result<String> {
        let _guard = self.mutex.lock().await;
        let current = read_cli_oauth(&self.path)?;
        if !force && current.expires > now_ms()?.saturating_add(REFRESH_SKEW_MS) {
            return Ok(current.access);
        }
        let response = self
            .client
            .post(&self.refresh_url)
            .json(&json!({
                "grant_type": "refresh_token",
                "refresh_token": current.refresh,
                "client_id": "opencode-cli",
            }))
            .send()
            .await?;
        if !response.status().is_success() {
            bail!(
                "OpenCode CLI OAuth refresh failed (HTTP {}); sign in again",
                response.status()
            );
        }
        let refreshed: RefreshedToken = response.json().await?;
        if refreshed.access_token.is_empty() || refreshed.refresh_token.is_empty() {
            bail!("OpenCode CLI OAuth refresh returned empty tokens");
        }
        let updated = CliOAuth {
            kind: "oauth".into(),
            access: refreshed.access_token,
            refresh: refreshed.refresh_token,
            expires: now_ms()?.saturating_add(refreshed.expires_in.saturating_mul(1000)),
        };
        // Preserve every other credential in OpenCode's auth.json while rotating its tokens.
        let mut data: Value = serde_json::from_slice(&std::fs::read(&self.path)?)?;
        let fields = data
            .get_mut("opencode")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("OpenCode CLI login changed during refresh"))?;
        if fields.get("refresh").and_then(Value::as_str) != Some(current.refresh.as_str()) {
            bail!("OpenCode CLI login rotated concurrently; retry the request");
        }
        fields.insert("access".into(), json!(updated.access));
        fields.insert("refresh".into(), json!(updated.refresh));
        fields.insert("expires".into(), json!(updated.expires));
        write_private_file(&self.path, &serde_json::to_string(&data)?)?;
        Ok(updated.access)
    }
}

#[async_trait]
impl AuthProvider for CliAuth {
    async fn get_auth_header(&self) -> Result<(String, String)> {
        Ok((
            "Authorization".into(),
            format!("Bearer {}", self.token(false).await?),
        ))
    }

    async fn refresh_credentials(&self) -> Result<()> {
        self.token(true).await?;
        Ok(())
    }
}

fn stream_client(
    base_url: String,
    auth: AuthMethod,
    tls_config: Option<TlsConfig>,
) -> Result<ApiClient> {
    let session_header = crate::session_context::session_id_request_builder_with_header_override(
        Some("x-opencode-session"),
    )?;
    let request_builder = std::sync::Arc::new(move |request: reqwest::RequestBuilder| {
        session_header(request.header("User-Agent", "aegis/1.0"))
    });
    Ok(
        ApiClient::with_timeout_and_tls(base_url, auth, Duration::from_secs(300), tls_config)?
            .with_request_builder(request_builder),
    )
}

impl ProviderDef for OpenCodeGoProvider {
    type Provider = Self;

    fn from_env(
        _extensions: Vec<ExtensionConfig>,
        tls_config: Option<TlsConfig>,
    ) -> BoxFuture<'static, Result<Self::Provider>> {
        Box::pin(async move {
            let auth = match Config::global().get_secret::<String>("OPENCODE_GO_API_KEY") {
                Ok(key) if !key.trim().is_empty() => AuthMethod::BearerToken(key),
                Ok(_) => bail!("OPENCODE_GO_API_KEY is empty"),
                Err(crate::config::ConfigError::NotFound(_)) => {
                    let path = cli_auth_path()?;
                    read_cli_oauth(&path)?;
                    AuthMethod::Custom(Box::new(CliAuth::new(path, tls_config.as_ref())?))
                }
                Err(error) => return Err(error.into()),
            };
            Ok(Self {
                client: stream_client(BASE_URL.to_string(), auth, tls_config)?,
            })
        })
    }
}

#[async_trait]
impl Provider for OpenCodeGoProvider {
    fn get_name(&self) -> &str {
        PROVIDER_NAME
    }

    async fn refresh_credentials(&self) -> Result<(), ProviderError> {
        self.client
            .refresh_credentials()
            .await
            .map_err(|error| ProviderError::Authentication(error.to_string()))
    }

    async fn get_context_limit(&self, model: &str, override_limit: Option<usize>) -> usize {
        override_limit.unwrap_or_else(|| context_limit_for(model))
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(CHAT_MODELS
            .iter()
            .map(|model| (*model).to_string())
            .collect())
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        if !CHAT_MODELS.contains(&model_config.model_name.as_str()) {
            return Err(ProviderError::RequestFailed(format!(
                "{} is not a supported OpenCode Go Chat Completions model",
                model_config.model_name
            )));
        }
        let mut payload = create_request_with_options(
            model_config,
            system,
            messages,
            tools,
            &ImageFormat::OpenAi,
            true,
            OpenAiFormatOptions {
                preserve_thinking_context: true,
                ..Default::default()
            },
        )?;
        // OpenCode Go's Chat Completions endpoint does not promise the provider-specific
        // reasoning_effort wire extension; avoid forwarding Aegis's generic option.
        if let Some(object) = payload.as_object_mut() {
            object.remove("reasoning_effort");
        }
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
    fn only_chat_completions_models_are_listed() {
        let metadata = OpenCodeGoProvider::metadata();
        assert_eq!(metadata.default_model, MODEL);
        assert!(metadata
            .known_models
            .iter()
            .any(|model| model.name == "glm-5.3-flash"));
        assert!(!metadata
            .known_models
            .iter()
            .any(|model| model.name == "minimax-m3"));
    }

    #[tokio::test]
    async fn deepseek_flash_context_limit_matches_go_catalog_and_respects_override() {
        let metadata = OpenCodeGoProvider::metadata();
        let deepseek = metadata
            .known_models
            .iter()
            .find(|model| model.name == MODEL)
            .unwrap();
        assert_eq!(deepseek.context_limit, Some(1_000_000));
        let other = metadata
            .known_models
            .iter()
            .find(|model| model.name == "glm-5.3-flash")
            .unwrap();
        assert_eq!(other.context_limit, Some(DEFAULT_CONTEXT_LIMIT));
        let provider = OpenCodeGoProvider {
            client: stream_client(
                BASE_URL.to_string(),
                AuthMethod::BearerToken("test".to_string()),
                None,
            )
            .unwrap(),
        };
        assert_eq!(provider.get_context_limit(MODEL, None).await, 1_000_000);
        assert_eq!(
            provider.get_context_limit("glm-5.3-flash", None).await,
            DEFAULT_CONTEXT_LIMIT
        );
        assert_eq!(
            provider.get_context_limit(MODEL, Some(123_456)).await,
            123_456
        );
    }

    #[tokio::test]
    async fn cli_auth_reads_existing_token_and_rotates_only_opencode_entry() {
        let server = MockServer::start().await;
        let directory = tempfile::tempdir().unwrap();
        let auth_path = directory.path().join("auth.json");
        write_private_file(&auth_path, &serde_json::to_string(&json!({
            "opencode": {"type": "oauth", "access": "old", "refresh": "refresh-old", "expires": now_ms().unwrap() + 600_000},
            "other-provider": {"type": "api", "key": "untouched"}
        })).unwrap()).unwrap();
        let auth = CliAuth {
            path: auth_path.clone(),
            refresh_url: format!("{}/auth/device/token", server.uri()),
            client: reqwest::Client::new(),
            mutex: Mutex::new(()),
        };
        let (_, bearer) = auth.get_auth_header().await.unwrap();
        assert_eq!(bearer, "Bearer old");
        Mock::given(method("POST"))
            .and(path("/auth/device/token"))
            .and(wiremock::matchers::body_json(json!({
                "grant_type": "refresh_token", "refresh_token": "refresh-old", "client_id": "opencode-cli"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "new", "refresh_token": "refresh-new", "expires_in": 3600
            })))
            .expect(1)
            .mount(&server)
            .await;
        auth.refresh_credentials().await.unwrap();
        let persisted: Value = serde_json::from_slice(&std::fs::read(&auth_path).unwrap()).unwrap();
        assert_eq!(persisted["opencode"]["access"], "new");
        assert_eq!(persisted["opencode"]["refresh"], "refresh-new");
        assert_eq!(persisted["other-provider"]["key"], "untouched");
        let (_, bearer) = auth.get_auth_header().await.unwrap();
        assert_eq!(bearer, "Bearer new");
    }

    #[tokio::test]
    async fn expired_cli_login_refreshes_before_sending_inference() {
        let server = MockServer::start().await;
        let directory = tempfile::tempdir().unwrap();
        let auth_path = directory.path().join("auth.json");
        write_private_file(&auth_path, &serde_json::to_string(&json!({
            "opencode": {"type": "oauth", "access": "expired", "refresh": "refresh-old", "expires": 1}
        })).unwrap()).unwrap();
        Mock::given(method("POST"))
            .and(path("/auth/device/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "fresh", "refresh_token": "refresh-new", "expires_in": 3600
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("authorization", "Bearer fresh"))
            .and(header("x-opencode-session", "test-session"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n",
                "text/event-stream",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let auth = CliAuth {
            path: auth_path.clone(),
            refresh_url: format!("{}/auth/device/token", server.uri()),
            client: reqwest::Client::new(),
            mutex: Mutex::new(()),
        };
        let provider = OpenCodeGoProvider {
            client: stream_client(server.uri(), AuthMethod::Custom(Box::new(auth)), None).unwrap(),
        };
        crate::session_context::with_session_id(Some("test-session".into()), async {
            let stream = provider
                .stream(&ModelConfig::new(MODEL), "", &[], &[])
                .await
                .unwrap();
            let events: Vec<_> = stream.collect().await;
            assert!(!events.is_empty());
        })
        .await;
        let data: Value = serde_json::from_slice(&std::fs::read(auth_path).unwrap()).unwrap();
        assert_eq!(data["opencode"]["refresh"], "refresh-new");
    }

    #[tokio::test]
    async fn sends_session_header_and_streams_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("authorization", "Bearer test-key"))
            .and(header("x-opencode-session", "test-session"))
            .and(header("user-agent", "aegis/1.0"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n",
                "text/event-stream",
            ))
            .mount(&server)
            .await;
        let provider = OpenCodeGoProvider {
            client: stream_client(
                server.uri(),
                AuthMethod::BearerToken("test-key".into()),
                None,
            )
            .unwrap(),
        };
        crate::session_context::with_session_id(Some("test-session".into()), async {
            let stream = provider
                .stream(&ModelConfig::new(MODEL), "", &[], &[])
                .await
                .unwrap();
            let events: Vec<_> = stream.collect().await;
            assert!(!events.is_empty());
        })
        .await;
    }
}
