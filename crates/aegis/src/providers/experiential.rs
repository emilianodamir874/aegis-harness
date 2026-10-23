use super::api_client::{ApiClient, AuthMethod};
use super::base::{ConfigKey, MessageStream, Provider, ProviderDef, ProviderMetadata};
use super::openai_compatible::{
    handle_response_openai_compat, handle_status, map_http_error_to_provider_error,
    stream_openai_compat,
};
use super::retry::ProviderRetry;
use crate::conversation::message::Message;
use aegis_providers::errors::ProviderError;
use aegis_providers::images::ImageFormat;
use anyhow::Result;
use async_trait::async_trait;
use futures::future::BoxFuture;

use aegis_providers::formats::openai::create_request;
use aegis_providers::model::ModelConfig;
use aegis_providers::request_log::{start_log, LoggerHandleExt};
use rmcp::model::Tool;
use serde_json::Value;

/// Experiential Labs es un gateway OpenAI-compatible: un solo base URL delante de todos los
/// modelos (proveedores hospedados, claves propias BYOK, creditos de la plataforma y modelos
/// locales). Contrato publicado en https://platform.experientiallabs.ai/llms.txt :
/// `base_url = https://api.experientiallabs.ai/v1`, `Authorization: Bearer xpl_<40 hex>`,
/// claves de organizacion que sirven tanto para `/v1/*` como para `/api/*`.
pub const EXPERIENTIAL_PROVIDER_NAME: &str = "experiential";
pub const EXPERIENTIAL_DOC_URL: &str = "https://platform.experientiallabs.ai/docs";
pub const EXPERIENTIAL_KEYS_URL: &str = "https://platform.experientiallabs.ai/settings/api-keys";
pub const EXPERIENTIAL_CREDITS_URL: &str = "https://platform.experientiallabs.ai/settings";
pub const EXPERIENTIAL_DEFAULT_HOST: &str = "https://api.experientiallabs.ai";
pub const EXPERIENTIAL_DEFAULT_MODEL: &str = "deepseek-v4.1-flash";

/// Slugs verificados contra el catalogo y el llms.txt del gateway; `/v1/models` (ver
/// `fetch_supported_models`) devuelve la lista real de la organizacion y reemplaza estos.
pub const EXPERIENTIAL_KNOWN_MODELS: &[&str] = &[
    EXPERIENTIAL_DEFAULT_MODEL,
    "gpt-5.5",
    "claude-opus-5",
    "gemini-3.7-flash",
    "qwen3.8-27b",
];

#[derive(serde::Serialize)]
pub struct ExperientialProvider {
    #[serde(skip)]
    api_client: ApiClient,
    supports_streaming: bool,
    #[serde(skip)]
    name: String,
}

impl ExperientialProvider {
    pub async fn from_env(
        tls_config: Option<crate::providers::api_client::TlsConfig>,
    ) -> Result<Self> {
        let config = crate::config::Config::global();
        let api_key: String = config.get_secret("EXPERIENTIAL_API_KEY").map_err(|_| {
            anyhow::anyhow!(
                "Experiential Labs no esta configurado: falta EXPERIENTIAL_API_KEY (generala en {EXPERIENTIAL_KEYS_URL} y ponela en secrets.yaml)"
            )
        })?;
        if api_key.trim().is_empty() {
            anyhow::bail!(
                "EXPERIENTIAL_API_KEY esta vacia; genera una clave xpl_ en {EXPERIENTIAL_KEYS_URL}"
            );
        }
        let host: String = config
            .get_param("EXPERIENTIAL_HOST")
            .unwrap_or_else(|_| EXPERIENTIAL_DEFAULT_HOST.to_string());

        let auth = AuthMethod::BearerToken(api_key);
        let api_client = ApiClient::new_with_tls(host, auth, tls_config)?
            .with_request_builder(crate::session_context::session_id_request_builder())
            .with_header("X-Title", "aegis")?;

        Ok(Self {
            api_client,
            supports_streaming: true,
            name: EXPERIENTIAL_PROVIDER_NAME.to_string(),
        })
    }

    /// El gateway responde `{"error":{"code":"invalid_key","type":"authentication_error",...}}`:
    /// el codigo puede ser string, no numero, asi que no alcanza con mapear por status.
    fn error_from_experiential_payload(payload: &Value, url: &str) -> ProviderError {
        let error = payload.get("error");
        let code = error
            .and_then(|e| e.get("code"))
            .map(|c| {
                c.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| c.to_string())
            })
            .unwrap_or_else(|| "unknown".to_string());
        let kind = error
            .and_then(|e| e.get("type"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        let message = error
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("Experiential Labs devolvio un error sin mensaje");

        let normalized = format!("{code} {kind} {}", message.to_ascii_lowercase());
        if normalized.contains("authentication") || normalized.contains("invalid_key") {
            return ProviderError::Authentication(format!("{message} (codigo {code})"));
        }
        if normalized.contains("insufficient_quota")
            || normalized.contains("credit")
            || normalized.contains("quota")
        {
            return ProviderError::CreditsExhausted {
                details: format!("{message} (codigo {code})"),
                top_up_url: Some(EXPERIENTIAL_CREDITS_URL.to_string()),
            };
        }
        if let Ok(status) = code.parse::<u16>() {
            if let Ok(status) = reqwest::StatusCode::from_u16(status) {
                return map_http_error_to_provider_error(status, Some(payload.clone()), url);
            }
        }
        ProviderError::RequestFailed(format!("{message} (codigo {code}) [{url}]"))
    }
}

impl aegis_providers::base::ProviderDescriptor for ExperientialProvider {
    fn metadata() -> ProviderMetadata {
        ProviderMetadata::new(
            EXPERIENTIAL_PROVIDER_NAME,
            "Experiential Labs",
            "Gateway OpenAI-compatible: todos los modelos con una sola clave (BYOK o creditos)",
            EXPERIENTIAL_DEFAULT_MODEL,
            EXPERIENTIAL_KNOWN_MODELS.to_vec(),
            EXPERIENTIAL_DOC_URL,
            vec![
                ConfigKey::new("EXPERIENTIAL_API_KEY", true, true, None, true),
                ConfigKey::new(
                    "EXPERIENTIAL_HOST",
                    false,
                    false,
                    Some(EXPERIENTIAL_DEFAULT_HOST),
                    false,
                ),
            ],
        )
    }
}

impl ProviderDef for ExperientialProvider {
    type Provider = Self;

    fn from_env(
        _extensions: Vec<crate::config::ExtensionConfig>,
        tls_config: Option<crate::providers::api_client::TlsConfig>,
    ) -> BoxFuture<'static, Result<Self::Provider>> {
        Box::pin(Self::from_env(tls_config))
    }
}

#[async_trait]
impl Provider for ExperientialProvider {
    fn get_name(&self) -> &str {
        &self.name
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let payload = create_request(
            model_config,
            system,
            messages,
            tools,
            &ImageFormat::OpenAi,
            true,
        )?;

        let mut log = start_log(model_config, &payload)?;

        let response = self
            .with_retry(|| async {
                let resp = self
                    .api_client
                    .request("v1/chat/completions")
                    .model_headers(model_config)?
                    .streaming(true)
                    .response_post(&payload)
                    .await?;
                let resp = handle_status(resp).await?;

                let is_json = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_ascii_lowercase())
                    .is_some_and(|v| v.contains("json"));

                if is_json {
                    let body = aegis_providers::http_status::read_error_body(resp)
                        .await
                        .unwrap_or_default();
                    if let Ok(payload) = serde_json::from_str::<Value>(&body) {
                        if payload.get("error").is_some() {
                            return Err(Self::error_from_experiential_payload(
                                &payload,
                                "v1/chat/completions",
                            ));
                        }
                    }
                    return Err(ProviderError::ExecutionError(format!(
                        "Expected streaming response but received non-streaming payload: {body}"
                    )));
                }

                Ok(resp)
            })
            .await
            .inspect_err(|e| {
                let _ = log.error(e);
            })?;

        stream_openai_compat(response, log)
    }

    /// `/v1/models` lista los slugs que la clave puede llamar: catalogo publico mas los modelos
    /// propios y locales de la organizacion. El inventario refresca desde aca.
    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        let response = self
            .api_client
            .response_get("v1/models")
            .await
            .map_err(|e| ProviderError::RequestFailed(e.to_string()))?;
        let json = handle_response_openai_compat(response).await?;

        if json.get("error").is_some() {
            return Err(Self::error_from_experiential_payload(&json, "v1/models"));
        }

        let arr = json.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
            ProviderError::RequestFailed("Missing 'data' array in models response".to_string())
        })?;
        let mut models: Vec<String> = arr
            .iter()
            .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        models.sort();
        Ok(models)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aegis_providers::base::ProviderDescriptor;
    use serde_json::json;

    #[test]
    fn error_payload_maps_authentication_by_string_code() {
        let payload = json!({
            "error": { "code": "invalid_key", "type": "authentication_error" }
        });
        match ExperientialProvider::error_from_experiential_payload(&payload, "test") {
            ProviderError::Authentication(msg) => assert!(msg.contains("invalid_key")),
            other => panic!("Expected Authentication, got {other:?}"),
        }
    }

    #[test]
    fn error_payload_maps_quota_to_credits_with_top_up_url() {
        let payload = json!({
            "error": { "code": "insufficient_quota", "message": "free limit reached" }
        });
        match ExperientialProvider::error_from_experiential_payload(&payload, "test") {
            ProviderError::CreditsExhausted { top_up_url, .. } => {
                assert_eq!(top_up_url.as_deref(), Some(EXPERIENTIAL_CREDITS_URL));
            }
            other => panic!("Expected CreditsExhausted, got {other:?}"),
        }
    }

    #[test]
    fn error_payload_falls_back_to_request_failed() {
        let payload =
            json!({ "error": { "code": "unsupported_capability", "message": "no tier" } });
        match ExperientialProvider::error_from_experiential_payload(&payload, "test") {
            ProviderError::RequestFailed(msg) => assert!(msg.contains("unsupported_capability")),
            other => panic!("Expected RequestFailed, got {other:?}"),
        }
    }

    #[test]
    fn metadata_declares_mandatory_secret_key() {
        let metadata = ExperientialProvider::metadata();
        let key = metadata
            .config_keys
            .iter()
            .find(|k| k.name == "EXPERIENTIAL_API_KEY")
            .expect("la clave obligatoria tiene que estar declarada");
        assert!(key.required, "EXPERIENTIAL_API_KEY debe ser obligatoria");
        assert!(key.secret, "EXPERIENTIAL_API_KEY debe ser secreta");
    }
}
