use super::api_client::{ApiClient, AuthMethod};
use super::base::{ConfigKey, MessageStream, ModelInfo, Provider, ProviderDef, ProviderMetadata};
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
/// El operador solo quiere esta variante: DeepSeek V4.1 Flash uncensored/abliterated del
/// catalogo de Experiential. Verificado contra el gateway: tools=true, responde tool_calls y
/// cuesta ~$0.00007 por pedido corto.
pub const EXPERIENTIAL_DEFAULT_MODEL: &str = "deepseek-v4.1-flash-uncensored";

/// Catalogo completo del gateway al 2026-10-29 (294 slugs que la clave puede llamar). Es la
/// lista de respaldo: `GET /v1/models` la reemplaza en el inventario cuando el refresco corre,
/// pero el desplegable nunca arranca con un solo modelo porque la clave rote o falte el refresco.
/// El default va primero; el resto en orden alfabetico para que el picker no cambie de orden.
pub const EXPERIENTIAL_KNOWN_MODELS: &[&str] = &[
    "deepseek-v4.1-flash-uncensored",
    "aion-2.0",
    "aion-3.0",
    "aion-3.0-mini",
    "aion-rp-llama-3.1-8b",
    "claude-fable-5",
    "claude-fable-5.1",
    "claude-fable-latest",
    "claude-haiku-4.5",
    "claude-haiku-5.5",
    "claude-haiku-latest",
    "claude-opus-4.5",
    "claude-opus-4.6",
    "claude-opus-4.7",
    "claude-opus-4.8",
    "claude-opus-5",
    "claude-opus-5.5",
    "claude-opus-latest",
    "claude-sonnet-4.5",
    "claude-sonnet-4.6",
    "claude-sonnet-5",
    "claude-sonnet-5.5",
    "claude-sonnet-latest",
    "clef",
    "clef-flash",
    "codestral-2508",
    "codestral-embed",
    "command-a",
    "command-r-08-2024",
    "command-r-plus-08-2024",
    "command-r7b-12-2024",
    "cydonia-24b-v4.1",
    "deepseek-r1",
    "deepseek-r1-0528",
    "deepseek-v3.2",
    "deepseek-v3.2-exp",
    "deepseek-v3.2-speciale",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4.1-flash",
    "deepseek-v4.1-flash-1017",
    "dolphin-mistral-24b-venice-edition",
    "eleven_flash_v2_5",
    "eleven_multilingual_v2",
    "eleven_turbo_v2_5",
    "eleven_v3",
    "eleven_v4",
    "eleven_v4_turbo",
    "ernie-4.5-vl-424b-a47b",
    "fugu-max",
    "fugu-ultra",
    "fugu-ultra-v2",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.5-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-4-argon",
    "gemini-flash-latest",
    "gemini-pro-latest",
    "gemma-2-27b-it",
    "gemma-3-12b-it",
    "gemma-3-27b-it",
    "gemma-3-4b-it",
    "gemma-4-26b-a4b-it",
    "gemma-4-31b-it",
    "glm-4.6v",
    "glm-4.7",
    "glm-4.7-flash",
    "glm-5",
    "glm-5-turbo",
    "glm-5.1",
    "glm-5.2",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.3-flash-uncensored",
    "glm-5.3-uncensored",
    "glm-5v-turbo",
    "glm-latest",
    "gpt-3.5-turbo-16k",
    "gpt-4-turbo",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4o-mini-transcribe",
    "gpt-4o-mini-tts",
    "gpt-4o-transcribe",
    "gpt-4o-transcribe-diarize",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4-pro",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-luna-decisions",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-chat-latest",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-latest",
    "gpt-mini-latest",
    "gpt-oss-120b",
    "gpt-oss-20b",
    "gpt-oss-safeguard-20b",
    "gpt-transcribe",
    "grok-4",
    "grok-4.20",
    "grok-4.20-non-reasoning",
    "grok-4.3",
    "grok-4.5",
    "grok-4.6",
    "grok-4.7",
    "grok-build-0.1",
    "grok-code-fast-1",
    "grok-imagine-image-2.0",
    "grok-latest",
    "hermes-3-llama-3.1-405b",
    "hermes-3-llama-3.1-70b",
    "hermes-4-405b",
    "hunyuan-a13b-instruct",
    "hy-mt2-1.8b",
    "hy-mt2-30b-a3b",
    "hy-mt2-7b",
    "hy3",
    "hy3-preview",
    "hy4-preview",
    "inkling",
    "inkling-small",
    "jev-latest",
    "kimi-k2-0905",
    "kimi-k2-thinking",
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "kimi-k3",
    "kimi-latest",
    "laguna-s-2.1",
    "laguna-xs-2.1",
    "ling-3.0-flash",
    "ling-3.0-flash-fin",
    "ling-3.0-flash-sante",
    "ling-3.0-flash-vl",
    "ling-3.1-flash",
    "llama-3-lunaris-8b",
    "llama-3.1-70b-instruct",
    "llama-3.1-euryale-70b",
    "llama-3.3-70b-instruct",
    "llama-4-maverick",
    "llama-4-scout",
    "llama-guard-4-12b",
    "longcat-2.0",
    "magnum-v4-72b",
    "mercury-2",
    "mercury-3",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro",
    "mimo-v2.6-pro-ultraspeed",
    "minimax-01",
    "minimax-m1",
    "minimax-m2",
    "minimax-m2-her",
    "minimax-m2.1",
    "minimax-m2.5",
    "minimax-m3",
    "ministral-14b-2512",
    "ministral-3-3b-instruct",
    "ministral-3-8b-instruct",
    "mistral-large",
    "mistral-large-3",
    "mistral-large-4",
    "mistral-medium-3",
    "mistral-medium-3-5",
    "mistral-medium-3.1",
    "mistral-nemo",
    "mistral-saba",
    "mistral-small-2603",
    "mistral-small-3.1-24b-instruct",
    "mistral-small-3.2-24b-instruct",
    "mixtral-8x22b-instruct",
    "morph-v3-fast",
    "morph-v3-large",
    "muse-spark-1.1",
    "muse-spark-1.2",
    "muse-spark-1.2-contributor",
    "muse-spark-1.3",
    "muse-spark-1.3-contributor",
    "muse-spark-open",
    "muse-wonder-1.0",
    "nemotron-3-nano-30b-a3b",
    "nemotron-3-super-120b-a12b",
    "nemotron-3-ultra-550b-a55b",
    "nemotron-3.5-lightning",
    "nova-2-lite-v1",
    "nova-premier-v1",
    "o3",
    "o3-mini",
    "o3-mini-high",
    "o4-mini",
    "o4-mini-high",
    "perceptron-mk1",
    "phi-4",
    "qwen-mt-plus",
    "qwen-plus",
    "qwen2.5-vl-72b-instruct",
    "qwen3-14b",
    "qwen3-30b-a3b",
    "qwen3-32b",
    "qwen3-8b",
    "qwen3-coder-flash",
    "qwen3-next-80b-a3b-thinking",
    "qwen3-omni-30b-a3b-thinking",
    "qwen3.5-122b-a10b",
    "qwen3.5-27b",
    "qwen3.5-35b-a3b",
    "qwen3.5-397b-a17b",
    "qwen3.5-9b",
    "qwen3.5-flash-02-23",
    "qwen3.5-plus-02-15",
    "qwen3.5-plus-20260420",
    "qwen3.6-27b",
    "qwen3.6-35b-a3b",
    "qwen3.6-flash",
    "qwen3.6-plus",
    "qwen3.7-flash",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.8-2.4t-a95b",
    "qwen3.8-27b",
    "qwen3.8-flash",
    "qwen3.8-max",
    "qwen3.8-max-0902",
    "reka-edge",
    "reka-flash-3",
    "relace-apply-3",
    "relace-search",
    "remm-slerp-l2-13b",
    "scribe_v2",
    "seed-1.6",
    "seed-1.6-flash",
    "seed-2-1-turbo",
    "seed-2.0-code",
    "seed-2.0-lite",
    "seed-2.0-mini",
    "skyfall-36b-v2",
    "solar-pro-3",
    "solar-pro4",
    "sonar",
    "sonar-pro",
    "sonar-pro-search",
    "sonar-reasoning-pro",
    "step-3.5-flash",
    "text-embedding-3-large",
    "text-embedding-3-small",
    "text-embedding-ada-002",
    "tts-1",
    "tts-1-1106",
    "tts-1-hd",
    "tts-1-hd-1106",
    "ui-tars-1.5-7b",
    "unslopnemo-12b",
    "veo-3.1-fast-generate-preview",
    "veo-3.1-generate-preview",
    "veo-3.1-lite-generate-preview",
    "weaver",
    "whisper-1",
];

/// Ventana declarada para la familia DeepSeek V4.1 Flash. El catalogo del gateway no publica
/// limites por modelo y el default del harness es 128k, que compacta esta familia mucho antes de
/// lo necesario. Se declara 1M redondo: si el modelo real admitiera 1.048.576, quedarse 48k corto
/// solo hace compactar un poco antes, mientras que declarar de mas haria que un pedido se pase del
/// limite real y vuelva 400 en medio del turno.
const EXPERIENTIAL_CONTEXT_LIMIT: usize = 1_000_000;

fn context_limit_for(model_name: &str) -> Option<usize> {
    model_name
        .starts_with("deepseek-v4.1-flash")
        .then_some(EXPERIENTIAL_CONTEXT_LIMIT)
}

fn resolve_context_limit(model: &str, override_limit: Option<usize>) -> usize {
    if let Some(limit) = override_limit.or_else(|| context_limit_for(model)) {
        return limit;
    }
    aegis_providers::context_limit::ContextLimitResolver::new(EXPERIENTIAL_PROVIDER_NAME)
        .resolve_local(model, None)
}

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
        let models = EXPERIENTIAL_KNOWN_MODELS
            .iter()
            .map(|name| match context_limit_for(name) {
                Some(limit) => ModelInfo::new(*name).with_context_limit(limit),
                None => ModelInfo::new(*name),
            })
            .collect();
        ProviderMetadata::with_models(
            EXPERIENTIAL_PROVIDER_NAME,
            "Experiential Labs",
            "Gateway OpenAI-compatible: todos los modelos con una sola clave (BYOK o creditos)",
            EXPERIENTIAL_DEFAULT_MODEL,
            models,
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

    async fn get_context_limit(&self, model: &str, override_limit: Option<usize>) -> usize {
        resolve_context_limit(model, override_limit)
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
    fn known_models_cover_the_whole_gateway_catalog() {
        let names: Vec<&str> = EXPERIENTIAL_KNOWN_MODELS.to_vec();
        let unique: std::collections::HashSet<&&str> = names.iter().collect();
        assert_eq!(
            names.len(),
            unique.len(),
            "el catalogo declarado no puede repetir slugs"
        );
        assert_eq!(
            names.first().copied(),
            Some(EXPERIENTIAL_DEFAULT_MODEL),
            "el modelo por defecto va primero: el desplegable lo muestra arriba"
        );
        assert!(
            names.len() >= 250,
            "el catalogo del gateway trae ~300 slugs; declarar menos deja modelos sin ofrecer"
        );
        for required in [
            "deepseek-v4.1-flash-uncensored",
            "kimi-k2.6",
            "gpt-5.5",
            "claude-sonnet-4.5",
        ] {
            assert!(
                names.contains(&required),
                "{required} falta en el catalogo declarado"
            );
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

    #[test]
    fn deepseek_v41_flash_family_declares_one_million() {
        assert_eq!(
            context_limit_for(EXPERIENTIAL_DEFAULT_MODEL),
            Some(EXPERIENTIAL_CONTEXT_LIMIT)
        );
        assert_eq!(
            context_limit_for("deepseek-v4.1-flash"),
            Some(EXPERIENTIAL_CONTEXT_LIMIT)
        );
        assert_eq!(context_limit_for("kimi-k2.6"), None);
    }

    #[test]
    fn context_limit_prefers_override_then_declared_then_default() {
        assert_eq!(
            resolve_context_limit(EXPERIENTIAL_DEFAULT_MODEL, Some(64_000)),
            64_000
        );
        assert_eq!(
            resolve_context_limit(EXPERIENTIAL_DEFAULT_MODEL, None),
            EXPERIENTIAL_CONTEXT_LIMIT
        );
        assert_eq!(
            resolve_context_limit("kimi-k2.6", None),
            aegis_providers::model::DEFAULT_CONTEXT_LIMIT
        );
    }

    #[test]
    fn metadata_declares_one_million_for_default_model() {
        let metadata = ExperientialProvider::metadata();
        let info = metadata
            .known_models
            .iter()
            .find(|m| m.name == EXPERIENTIAL_DEFAULT_MODEL)
            .expect("el modelo por defecto tiene que estar en el catalogo declarado");
        assert_eq!(info.context_limit, Some(EXPERIENTIAL_CONTEXT_LIMIT));
    }
}
