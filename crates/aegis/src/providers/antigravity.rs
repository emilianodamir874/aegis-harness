use crate::conversation::message::Message;
use crate::providers::base::{
    ConfigKey, MessageStream, ModelInfo, Provider, ProviderDef, ProviderMetadata,
};
use crate::providers::formats::google::{create_request, response_to_streaming_message};
use anyhow::{anyhow, Result};
use async_stream::try_stream;
use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::TryStreamExt;
use aegis_providers::errors::ProviderError;
use aegis_providers::model::ModelConfig;
use aegis_providers::request_log::{start_log, LoggerHandleExt};
use rmcp::model::Tool;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::pin;
use tokio::sync::Mutex;
use tokio_stream::StreamExt;
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio_util::io::StreamReader;
use uuid::Uuid;

const NAME: &str = "antigravity";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DEFAULT_MODEL: &str = "gemini-3.8-flash-medium";
const GEMINI_38_CONTEXT_LIMIT: usize = 1_048_576;

fn advertised_context_limit(model: &str) -> Option<usize> {
    matches!(
        model,
        "gemini-3.8-flash"
            | "gemini-3.8-flash-high"
            | "gemini-3.8-flash-medium"
            | "gemini-3.8-flash-low"
    )
    .then_some(GEMINI_38_CONTEXT_LIMIT)
}

const ENDPOINTS: &[&str] = &[
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
];
const USER_AGENT: &str = "antigravity/cli/1.2.4 (aidev_client; os_type=windows; arch=amd64; cl=982146307; auth_method=consumer)";
/// Ids the consumer surface (the `daily-*` endpoints) actually serves.
///
/// Retired ids do not simply fail: they answer 404 on the daily endpoints, and
/// the walk then reaches `cloudcode-pa`, which answers 429 RESOURCE_EXHAUSTED
/// for every model on a consumer token. Offering a retired id therefore made
/// aegis report a bogus "Rate limit exceeded" for a model that no longer exists
/// (measured 2026-10-13: gemini-3.6-flash, gemini-3.7-flash and gemini-3.1-pro
/// were gone from both daily catalogs while `cloudcode-pa` still listed them).
const MODELS: &[&str] = &[
    "gemini-3.8-flash",
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
];

fn runtime_model(model: &str, effort: Option<aegis_providers::thinking::ThinkingEffort>) -> &str {
    use aegis_providers::thinking::ThinkingEffort;
    match model {
        "gemini-3.8-flash" => match effort.unwrap_or(ThinkingEffort::Off) {
            ThinkingEffort::High | ThinkingEffort::Max => "gemini-3.8-flash-high",
            ThinkingEffort::Medium => "gemini-3.8-flash-medium",
            _ => "gemini-3.8-flash-low",
        },
        "claude-opus-4-6" => "claude-opus-4-6-thinking",
        _ => model,
    }
}

fn model_output_cap(model: &str) -> i32 {
    if model.starts_with("claude-") {
        64_000
    } else if model.starts_with("gpt-oss-") {
        32_768
    } else if model.starts_with("gemini-3.8-") {
        65_536
    } else {
        65_535
    }
}

fn oauth_client_id() -> String {
    std::env::var("ANTIGRAVITY_CLIENT_ID").unwrap_or_else(|_| {
        [
            "1071006060591-tmhssin2h21lcre235vtolojh4g403ep",
            ".apps.googleusercontent.com",
        ]
        .concat()
    })
}

fn oauth_client_secret() -> String {
    std::env::var("ANTIGRAVITY_CLIENT_SECRET")
        .unwrap_or_else(|_| ["GOCSPX-", "K58FWR486L", "dLJ1mLB8sXC4z6qDAf"].concat())
}

#[cfg(windows)]
fn read_agy_refresh_token() -> Result<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::wincred::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};

    let target: Vec<u16> = OsStr::new("gemini:antigravity")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    // The returned blob belongs to CredReadW and must be copied before CredFree.
    let bytes = unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
            return Err(anyhow!(
                "Antigravity login not found in Windows Credential Manager; sign in with agy first"
            ));
        }
        let item = &*credential;
        let blob =
            std::slice::from_raw_parts(item.CredentialBlob, item.CredentialBlobSize as usize)
                .to_vec();
        CredFree(credential.cast());
        blob
    };
    let value: Value = serde_json::from_slice(&bytes).or_else(|_| {
        let text = String::from_utf8_lossy(&bytes);
        serde_json::from_str(text.trim_end_matches('\0'))
    })?;
    value
        .pointer("/token/refresh_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("Antigravity credential has no refresh token"))
}

#[cfg(not(windows))]
fn read_agy_refresh_token() -> Result<String> {
    Err(anyhow!(
        "This provider currently requires agy's Windows Credential Manager login"
    ))
}

pub fn agy_login_available() -> bool {
    read_agy_refresh_token().is_ok()
}

struct Session {
    token: String,
    project: String,
    expires: Instant,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
}

pub struct AntigravityProvider {
    http: reqwest::Client,
    session: Mutex<Option<Session>>,
    conversation_id: String,
    trajectory_id: String,
}

impl AntigravityProvider {
    pub async fn from_env(_tls: Option<crate::providers::api_client::TlsConfig>) -> Result<Self> {
        // Validate locally at selection time; never persist the refresh token in Aegis.
        read_agy_refresh_token()?;
        Ok(Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(180))
                .build()?,
            session: Mutex::new(None),
            conversation_id: Uuid::new_v4().to_string(),
            trajectory_id: Uuid::new_v4().to_string(),
        })
    }

    async fn credentials(&self) -> Result<(String, String)> {
        let mut guard = self.session.lock().await;
        if let Some(s) = guard.as_ref() {
            if s.expires > Instant::now() + Duration::from_secs(60) {
                return Ok((s.token.clone(), s.project.clone()));
            }
        }
        let refresh = read_agy_refresh_token()?;
        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", oauth_client_id().as_str()),
                ("client_secret", oauth_client_secret().as_str()),
            ])
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "Antigravity OAuth refresh failed: HTTP {}",
                response.status()
            ));
        }
        let token: TokenResponse = response.json().await?;
        let project = if let Some(s) = guard.as_ref() {
            s.project.clone()
        } else {
            let mut project = None;
            let mut last_error = "no endpoint available".to_string();
            for endpoint in ENDPOINTS {
                match self
                    .http
                    .post(format!("{endpoint}/v1internal:loadCodeAssist"))
                    .bearer_auth(&token.access_token)
                    .header("User-Agent", USER_AGENT)
                    .json(&json!({"metadata":{"ideType":"ANTIGRAVITY"}}))
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => {
                        let value: Value = response.json().await?;
                        project = value
                            .get("cloudaicompanionProject")
                            .and_then(|v| {
                                v.as_str().or_else(|| v.get("id").and_then(Value::as_str))
                            })
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned);
                        if project.is_some() {
                            break;
                        }
                        last_error = "no companion project returned".to_string();
                    }
                    Ok(response)
                        if response.status().is_client_error()
                            && response.status() != reqwest::StatusCode::NOT_FOUND =>
                    {
                        return Err(anyhow!(
                            "Antigravity project discovery: HTTP {}",
                            response.status()
                        ));
                    }
                    Ok(response) => last_error = format!("HTTP {}", response.status()),
                    Err(error) => last_error = error.to_string(),
                }
            }
            project.ok_or_else(|| anyhow!("Antigravity project discovery failed: {last_error}"))?
        };
        *guard = Some(Session {
            token: token.access_token.clone(),
            project: project.clone(),
            expires: Instant::now() + Duration::from_secs(token.expires_in.unwrap_or(3600)),
        });
        Ok((token.access_token, project))
    }

    async fn post_stream(
        &self,
        model: &str,
        payload: &Value,
        step: usize,
    ) -> Result<reqwest::Response, ProviderError> {
        for attempt in 0..2 {
            let (token, project) = self
                .credentials()
                .await
                .map_err(|e| ProviderError::Authentication(e.to_string()))?;
            let body = wrap_request(
                model,
                &project,
                payload,
                step,
                &self.conversation_id,
                &self.trajectory_id,
            );
            match self.send_with_fallback(&token, &body, ENDPOINTS).await {
                Err(ProviderError::Authentication(_)) if attempt == 0 => {
                    self.session.lock().await.take();
                }
                result => return result,
            }
        }
        Err(ProviderError::Authentication(
            "Antigravity rejected the refreshed token".into(),
        ))
    }

    async fn send_with_fallback(
        &self,
        token: &str,
        body: &Value,
        endpoints: &[&str],
    ) -> Result<reqwest::Response, ProviderError> {
        let model = body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let mut last_error =
            ProviderError::RequestFailed("No Antigravity endpoint configured".into());
        // A model-level 404 (endpoint up, id not served) must outlive a later
        // endpoint's generic 429: walking daily -> sandbox -> prod with a retired
        // id used to end on "429 RESOURCE_EXHAUSTED" and hide the real cause.
        let mut model_error: Option<ProviderError> = None;
        let mut failed_endpoints: Vec<String> = Vec::new();
        for endpoint in endpoints {
            let response = self
                .http
                .post(format!(
                    "{endpoint}/v1internal:streamGenerateContent?alt=sse"
                ))
                .bearer_auth(token)
                .header("User-Agent", USER_AGENT)
                .json(body)
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    failed_endpoints.push(format!("{endpoint} unreachable"));
                    last_error = ProviderError::NetworkError(error.to_string());
                    continue;
                }
            };
            let status = response.status();
            if status.is_success() {
                return Ok(response);
            }
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err(ProviderError::Authentication(
                    "Antigravity rejected the access token".into(),
                ));
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                // Only trustworthy when the model itself was servable: if an earlier
                // endpoint already answered "not found" for this id, that is the real
                // answer and the 429 is an artefact of the endpoint walk.
                if let Some(error) = model_error.take() {
                    return Err(error);
                }
                let retry_delay = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(Duration::from_secs);
                let mut details = aegis_providers::http_status::read_error_body(response)
                    .await
                    .unwrap_or_else(|| "no error body".to_string());
                if !failed_endpoints.is_empty() {
                    details = format!(
                        "{details} (earlier endpoints failed: {})",
                        failed_endpoints.join(", ")
                    );
                }
                return Err(ProviderError::RateLimitExceeded {
                    details,
                    retry_delay,
                });
            }
            if status == reqwest::StatusCode::NOT_FOUND {
                let details = aegis_providers::http_status::read_error_body(response)
                    .await
                    .unwrap_or_default();
                failed_endpoints.push(format!("{endpoint} 404"));
                if is_model_level_not_found(&details) {
                    model_error.get_or_insert_with(|| {
                        ProviderError::RequestFailed(format!(
                            "Antigravity does not serve model '{model}' on {endpoint}: {details}; \
                             live models: {MODELS:?}"
                        ))
                    });
                } else {
                    last_error = ProviderError::ServerError(format!(
                        "Antigravity endpoint {endpoint}: HTTP {status}"
                    ));
                }
                continue;
            }
            if matches!(status.as_u16(), 500 | 502 | 503 | 504) {
                failed_endpoints.push(format!("{endpoint} {status}"));
                last_error = ProviderError::ServerError(format!(
                    "Antigravity endpoint {endpoint}: HTTP {status}"
                ));
                continue;
            }
            let details = aegis_providers::http_status::read_error_body(response)
                .await
                .unwrap_or_else(|| "no error body".to_string());
            return Err(ProviderError::RequestFailed(format!(
                "Antigravity HTTP {status} for model '{model}': {details}"
            )));
        }
        Err(model_error.unwrap_or(last_error))
    }
}

/// Distinguishes Google's own model-level NOT_FOUND (the endpoint is up, but the
/// requested id is not served there) from an opaque gateway 404 that only means
/// "this endpoint is unavailable, try the next one".
fn is_model_level_not_found(body: &str) -> bool {
    let value: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return false,
    };
    match value.get("error") {
        Some(error) => {
            error.get("status").and_then(Value::as_str) == Some("NOT_FOUND")
                || error.get("code").and_then(Value::as_i64) == Some(404)
        }
        None => false,
    }
}

fn model_enum(model: &str) -> Option<&'static str> {
    match model {
        "gemini-3.8-flash-high" => Some("MODEL_PLACEHOLDER_M318"),
        "gemini-3.8-flash-medium" => Some("MODEL_PLACEHOLDER_M319"),
        "gemini-3.8-flash-low" => Some("MODEL_PLACEHOLDER_M320"),
        "gemini-3.7-flash-high" => Some("MODEL_PLACEHOLDER_M298"),
        "gemini-3.7-flash-medium" => Some("MODEL_PLACEHOLDER_M299"),
        "gemini-3.7-flash-low" => Some("MODEL_PLACEHOLDER_M300"),
        "gemini-3.6-flash-high" => Some("MODEL_PLACEHOLDER_M71"),
        "gemini-3.6-flash-medium" => Some("MODEL_PLACEHOLDER_M72"),
        "gemini-3.6-flash-low" => Some("MODEL_PLACEHOLDER_M73"),
        "gemini-3.1-pro-low" => Some("MODEL_PLACEHOLDER_M36"),
        "gemini-3.1-pro-high" => Some("MODEL_PLACEHOLDER_M37"),
        "gemini-pro-agent" => Some("MODEL_PLACEHOLDER_M16"),
        "claude-sonnet-4-6" => Some("MODEL_PLACEHOLDER_M35"),
        "claude-opus-4-6-thinking" => Some("MODEL_PLACEHOLDER_M26"),
        "gpt-oss-120b-medium" => Some("MODEL_OPENAI_GPT_OSS_120B_MEDIUM"),
        _ => None,
    }
}

fn session_number(conversation: &str) -> String {
    let hash = Sha256::digest(format!("antigravity:session:{conversation}").as_bytes());
    i64::from_le_bytes(hash[..8].try_into().expect("SHA-256 digest is 32 bytes")).to_string()
}

fn execution_id(trajectory: &str, step: usize) -> String {
    let hash = Sha256::digest(format!("antigravity:exec:{trajectory}:{step}").as_bytes());
    let mut bytes: [u8; 16] = hash[..16].try_into().expect("SHA-256 digest is 32 bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn wrap_request(
    model: &str,
    project: &str,
    payload: &Value,
    step: usize,
    conversation: &str,
    trajectory: &str,
) -> Value {
    let mut inner = payload.clone();
    if let Some(obj) = inner.as_object_mut() {
        let claude = model.starts_with("claude-");
        let mut labels = json!({
            "last_step_index": step.saturating_sub(1).to_string(),
            "request_id": format!("{trajectory}-{}", step.saturating_sub(1)),
            "trajectory_id": trajectory,
            "used_claude": claude.to_string(),
            "used_claude_conservative": claude.to_string(),
            "used_non_gemini_model": (!model.starts_with("gemini-")).to_string(),
        });
        if let Some(model_enum) = model_enum(model) {
            labels["model_enum"] = json!(model_enum);
        }
        if step > 1 {
            labels["last_execution_id"] = json!(execution_id(trajectory, step - 1));
        }
        obj.insert("sessionId".into(), json!(session_number(conversation)));
        obj.insert("labels".into(), labels);
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_millis();
    json!({
        "project": project, "model": model, "request": inner,
        "requestType": "agent", "userAgent": "antigravity",
        "requestId": format!("agent/{conversation}/{millis}/{trajectory}/{step}"),
    })
}

fn unwrap_sse(line: &str) -> String {
    let Some(data) = line.strip_prefix("data:") else {
        return line.to_owned();
    };
    let data = data.trim_start();
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return format!("data: {data}");
    };
    match value.get("response") {
        Some(inner) => format!("data: {inner}"),
        None => format!("data: {data}"),
    }
}

impl aegis_providers::base::ProviderDescriptor for AntigravityProvider {
    fn metadata() -> ProviderMetadata {
        ProviderMetadata::with_models(
            NAME,
            "Antigravity",
            "Use your existing agy login via Windows Credential Manager",
            DEFAULT_MODEL,
            MODELS
                .iter()
                .map(|name| {
                    let info = ModelInfo::new(*name);
                    match advertised_context_limit(name) {
                        Some(limit) => info.with_context_limit(limit),
                        None => info,
                    }
                })
                .collect(),
            "https://github.com/aaif-goose/goose",
            vec![ConfigKey::new_oauth(
                "ANTIGRAVITY_TOKEN",
                true,
                true,
                None,
                false,
            )],
        )
    }
}

impl ProviderDef for AntigravityProvider {
    type Provider = Self;
    fn from_env(
        _extensions: Vec<crate::config::ExtensionConfig>,
        tls: Option<crate::providers::api_client::TlsConfig>,
    ) -> BoxFuture<'static, Result<Self>> {
        Box::pin(Self::from_env(tls))
    }
}

#[async_trait]
impl Provider for AntigravityProvider {
    fn get_name(&self) -> &str {
        NAME
    }

    async fn get_context_limit(&self, model: &str, override_limit: Option<usize>) -> usize {
        if let Some(limit) = override_limit.or_else(|| advertised_context_limit(model)) {
            return limit;
        }
        aegis_providers::context_limit::ContextLimitResolver::new(NAME)
            .resolve(model, None, || async { Ok(None) })
            .await
    }

    async fn configure_oauth(&self) -> Result<(), ProviderError> {
        self.credentials()
            .await
            .map_err(|e| ProviderError::Authentication(e.to_string()))?;
        Ok(())
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        let (token, project) = self
            .credentials()
            .await
            .map_err(|e| ProviderError::Authentication(e.to_string()))?;
        let mut last_error =
            ProviderError::RequestFailed("Model discovery: no endpoint available".into());
        for endpoint in ENDPOINTS {
            let response = self
                .http
                .post(format!("{endpoint}/v1internal:fetchAvailableModels"))
                .bearer_auth(&token)
                .header("User-Agent", USER_AGENT)
                .json(&json!({"project":project}))
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    let value: Value = response
                        .json()
                        .await
                        .map_err(|e| ProviderError::RequestFailed(e.to_string()))?;
                    let models =
                        value
                            .get("models")
                            .and_then(Value::as_object)
                            .ok_or_else(|| {
                                ProviderError::RequestFailed(
                                    "Model discovery returned no models".into(),
                                )
                            })?;
                    return Ok(models.keys().cloned().collect());
                }
                Ok(response)
                    if response.status().is_client_error()
                        && response.status() != reqwest::StatusCode::NOT_FOUND =>
                {
                    return Err(ProviderError::RequestFailed(format!(
                        "Model discovery: HTTP {}",
                        response.status()
                    )));
                }
                Ok(response) => {
                    last_error = ProviderError::ServerError(format!(
                        "Model discovery on {endpoint}: HTTP {}",
                        response.status()
                    ));
                }
                Err(error) => last_error = ProviderError::NetworkError(error.to_string()),
            }
        }
        Err(last_error)
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let runtime = runtime_model(&model_config.model_name, model_config.thinking_effort());
        let mut wire_config = model_config.clone();
        wire_config.model_name = runtime.to_string();
        wire_config.max_tokens = Some(
            model_config
                .max_output_tokens()
                .min(model_output_cap(runtime)),
        );
        let payload = create_request(&wire_config, system, messages, tools)?;
        let mut log = start_log(model_config, &payload)?;
        let pasos = messages.len().max(1);
        // Reintento por stream vacio. El proveedor puede cerrar la conexion en un borde de linea y el
        // parser termina sin error, dejando el turno SIN contenido (8 turnos "[]" en 40 min en la
        // sesion 20261012_5). El stream que se devuelve tiene que ser 'static, asi que el reintento se
        // hace ANTES de construirlo: se pide, se lee hasta el primer item CON contenido (guardando lo
        // previo) y, si una pasada no trae nada, se reintenta el pedido hasta MAX_PASADAS. Si ya hay
        // contenido, el stream sigue tal cual (sin buffering, no se pierde el streaming).
        const MAX_PASADAS: u32 = 3;
        let mut pasada: u32 = 0;
        let (previos, mut parser) = loop {
            pasada += 1;
            let response = self
                .post_stream(runtime, &payload, pasos)
                .await
                .inspect_err(|e| {
                    let _ = log.error(e);
                })?;
            // Instrumentacion (v38): sin esto los turnos vacios no dejaban NINGUNA huella (ni en el
            // log del serve ni en el de pedidos), asi que no habia forma de saber si el proveedor no
            // mando datos, si los mandamos y se perdieron, o si el pedido ni empezo.
            let estado_http = response.status().as_u16();
            // El contador va en un Arc: el stream que se devuelve tiene que ser 'static, asi que la
            // closure de map_ok no puede pedir prestado un local (error E0373 en el primer intento).
            let lineas_pasada = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let contador = std::sync::Arc::clone(&lineas_pasada);
            let bytes = response.bytes_stream().map_err(io::Error::other);
            let lines = FramedRead::new(StreamReader::new(bytes), LinesCodec::new())
                .map_ok(move |line| {
                    contador.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    unwrap_sse(&line)
                })
                .map_err(anyhow::Error::from);
            let mut parseando = Box::pin(response_to_streaming_message(lines));
            let mut previos = Vec::new();
            let mut hubo_contenido = false;
            while let Some(item) = parseando.next().await {
                let par = item.map_err(|e| {
                    e.downcast::<ProviderError>()
                        .unwrap_or_else(|e| ProviderError::stream_decode_error_with_causes(&e))
                })?;
                let tiene = par.0.is_some() || par.1.is_some();
                previos.push(par);
                if tiene {
                    hubo_contenido = true;
                    break;
                }
            }
            let lineas = lineas_pasada.load(std::sync::atomic::Ordering::Relaxed);
            tracing::info!(
                target: "aegis::providers::antigravity",
                pasada,
                estado_http,
                lineas,
                items_sin_contenido = previos.len(),
                hubo_contenido,
                "pasada de stream terminada"
            );
            if !hubo_contenido && pasada >= MAX_PASADAS {
                tracing::warn!(
                    target: "aegis::providers::antigravity",
                    pasada,
                    estado_http,
                    lineas,
                    "todas las pasadas volvieron sin contenido: el turno va a quedar vacio"
                );
            }
            if hubo_contenido || pasada >= MAX_PASADAS {
                break (previos, parseando);
            }
            tracing::warn!(
                target: "aegis::providers::antigravity",
                pasada,
                estado_http,
                lineas,
                "pasada sin contenido: se reintenta el pedido"
            );
        };
        Ok(Box::pin(try_stream! {
            for (message, usage) in previos {
                if message.is_some() || usage.is_some() {
                    log.write(&message, usage.as_ref().map(|u| u.usage).as_ref())?;
                }
                yield (message, usage);
            }
            while let Some(item) = parser.next().await {
                let (message, usage) = item.map_err(|e| {
                    e.downcast::<ProviderError>()
                        .unwrap_or_else(|e| ProviderError::stream_decode_error_with_causes(&e))
                })?;
                if message.is_some() || usage.is_some() {
                    log.write(&message, usage.as_ref().map(|u| u.usage).as_ref())?;
                }
                yield (message, usage);
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aegis_providers::base::ProviderDescriptor;

    #[tokio::test]
    async fn gemini_38_aliases_have_documented_context_with_override_precedence() {
        let provider = AntigravityProvider {
            http: reqwest::Client::new(),
            session: Mutex::new(None),
            conversation_id: String::new(),
            trajectory_id: String::new(),
        };
        for alias in [
            "gemini-3.8-flash",
            "gemini-3.8-flash-high",
            "gemini-3.8-flash-medium",
            "gemini-3.8-flash-low",
        ] {
            assert_eq!(provider.get_context_limit(alias, None).await, 1_048_576);
            assert_eq!(
                provider.get_context_limit(alias, Some(64_000)).await,
                64_000
            );
            let info = AntigravityProvider::metadata()
                .known_models
                .into_iter()
                .find(|info| info.name == alias)
                .unwrap();
            assert_eq!(info.context_limit, Some(1_048_576));
        }
        assert_eq!(
            provider
                .get_context_limit("unknown-antigravity-alias", None)
                .await,
            aegis_providers::model::DEFAULT_CONTEXT_LIMIT
        );
    }

    #[test]
    fn envelope_places_session_inside_request() {
        let body = wrap_request(
            "gemini-3.8-flash-medium",
            "proj",
            &json!({"contents":[]}),
            3,
            "conv",
            "traj",
        );
        assert!(body["requestId"]
            .as_str()
            .unwrap()
            .starts_with("agent/conv/"));
        assert!(body["requestId"].as_str().unwrap().ends_with("/traj/3"));
        assert_eq!(body["request"]["sessionId"], session_number("conv"));
        assert!(body.get("sessionId").is_none());
        assert_eq!(body["request"]["labels"]["last_step_index"], "2");
        assert_eq!(body["request"]["labels"]["used_claude"], "false");
        assert_eq!(
            body["request"]["labels"]["model_enum"],
            "MODEL_PLACEHOLDER_M319"
        );
        assert_eq!(
            body["request"]["labels"]["last_execution_id"],
            execution_id("traj", 2)
        );
        let first = wrap_request(
            "claude-sonnet-4-6",
            "proj",
            &json!({"contents":[]}),
            1,
            "conv",
            "traj",
        );
        assert!(first["request"]["labels"]
            .get("last_execution_id")
            .is_none());
        assert_eq!(first["request"]["labels"]["used_claude"], "true");
        assert_eq!(first["request"]["labels"]["used_non_gemini_model"], "true");
    }
    #[test]
    fn unwrap_response_for_google_parser() {
        assert_eq!(
            unwrap_sse("data: {\"response\":{\"candidates\":[]}}"),
            "data: {\"candidates\":[]}"
        );
        assert_eq!(
            unwrap_sse("data:{\"response\":{\"candidates\":[]}}"),
            "data: {\"candidates\":[]}"
        );
    }

    #[test]
    fn aliases_route_to_quota_bearing_models() {
        use aegis_providers::thinking::ThinkingEffort;
        assert_eq!(
            runtime_model("gemini-3.8-flash", None),
            "gemini-3.8-flash-low"
        );
        assert_eq!(
            runtime_model("gemini-3.8-flash", Some(ThinkingEffort::Medium)),
            "gemini-3.8-flash-medium"
        );
        assert_eq!(
            runtime_model("gemini-3.8-flash", Some(ThinkingEffort::High)),
            "gemini-3.8-flash-high"
        );
        assert_eq!(
            // Retired families (3.6-flash, 3.7-flash, 3.1-pro) are neither routed
            // nor advertised any more: their ids pass through unchanged and the
            // endpoint answers NOT_FOUND, which is reported as such instead of
            // being masked by the trailing 429 from cloudcode-pa.
            runtime_model("gemini-3.1-pro", Some(ThinkingEffort::High)),
            "gemini-3.1-pro"
        );
        assert_eq!(
            runtime_model("claude-opus-4-6", None),
            "claude-opus-4-6-thinking"
        );
        assert_eq!(
            runtime_model("gemini-3.8-flash-medium", None),
            "gemini-3.8-flash-medium"
        );
        assert_eq!(model_output_cap("claude-sonnet-4-6"), 64_000);
        assert_eq!(model_output_cap("gpt-oss-120b-medium"), 32_768);
    }

    #[test]
    fn advertised_models_exclude_retired_families() {
        // The daily endpoints no longer serve these, and advertising them is what
        // produced a bogus "Rate limit exceeded" for an id that 404s.
        let retired = [
            "gemini-3.6-flash",
            "gemini-3.6-flash-low",
            "gemini-3.6-flash-medium",
            "gemini-3.6-flash-high",
            "gemini-3.7-flash",
            "gemini-3.7-flash-low",
            "gemini-3.7-flash-medium",
            "gemini-3.7-flash-high",
            "gemini-3.1-pro",
            "gemini-3.1-pro-low",
            "gemini-3.1-pro-high",
            "gemini-pro-agent",
        ];
        for model in retired {
            assert!(
                !MODELS.contains(&model),
                "{model} is retired on the consumer surface"
            );
        }
        // Live ids the account is entitled to, kept in the advertised list.
        for model in [
            "gemini-3.8-flash",
            "gemini-3.8-flash-high",
            "gemini-3.8-flash-medium",
            "gemini-3.8-flash-low",
            "claude-sonnet-4-6",
            "claude-opus-4-6-thinking",
            "gpt-oss-120b-medium",
        ] {
            assert!(MODELS.contains(&model), "{model} must stay advertised");
        }
    }

    #[test]
    fn model_level_not_found_is_distinguished_from_opaque_404() {
        assert!(is_model_level_not_found(
            r#"{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}"#
        ));
        assert!(is_model_level_not_found(r#"{"error":{"code":404}}"#));
        assert!(!is_model_level_not_found(""));
        assert!(!is_model_level_not_found("<html>404 not found</html>"));
        assert!(!is_model_level_not_found(r#"{"error":{"code":429}}"#));
    }

    async fn endpoint_server(
        route: &str,
        handler: impl Fn(String) -> (axum::http::StatusCode, String) + Clone + Send + Sync + 'static,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use axum::{extract::Path, routing::post, Router};
        let app = Router::new().route(
            route,
            post(move |Path(endpoint): Path<String>| {
                let handler = handler.clone();
                async move {
                    let (status, body) = handler(endpoint);
                    (status, body)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), server)
    }

    #[tokio::test]
    async fn retired_model_reports_not_found_instead_of_the_trailing_429() {
        // Measured shape of the failure: daily -> 404, sandbox -> 404, prod -> 429
        // RESOURCE_EXHAUSTED. The last endpoint's 429 is an artefact of the walk and
        // must not hide the model-level 404.
        let (base, server) = endpoint_server(
            "/{endpoint}/v1internal:streamGenerateContent",
            |endpoint: String| {
                match endpoint.as_str() {
                    "sandbox" => (
                        axum::http::StatusCode::NOT_FOUND,
                        r#"{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}"#
                            .to_string(),
                    ),
                    _ => (
                        axum::http::StatusCode::TOO_MANY_REQUESTS,
                        r#"{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}"#
                            .to_string(),
                    ),
                }
            },
        )
        .await;
        let primary = format!("{base}/primary");
        let sandbox = format!("{base}/sandbox");
        let prod = format!("{base}/prod");
        let error = mock_provider()
            .send_with_fallback(
                "dummy",
                &json!({"model":"gemini-3.6-flash-low"}),
                &[&primary, &sandbox, &prod],
            )
            .await
            .unwrap_err();
        match error {
            ProviderError::RequestFailed(message) => {
                assert!(message.contains("gemini-3.6-flash-low"), "{message}");
                assert!(message.contains("does not serve"), "{message}");
            }
            other => panic!("expected RequestFailed, got {other}"),
        }
        server.abort();
    }

    #[tokio::test]
    async fn opaque_endpoint_404_still_fails_over() {
        // A gateway 404 without a Google error envelope is an endpoint outage and
        // must keep walking to the next endpoint.
        let (base, server) = endpoint_server(
            "/{endpoint}/v1internal:streamGenerateContent",
            |endpoint: String| match endpoint.as_str() {
                "primary" => (
                    axum::http::StatusCode::NOT_FOUND,
                    "<html>404 page not found</html>".to_string(),
                ),
                _ => (
                    axum::http::StatusCode::OK,
                    r#"{"response":{"candidates":[]}}"#.to_string(),
                ),
            },
        )
        .await;
        let primary = format!("{base}/primary");
        let secondary = format!("{base}/secondary");
        let response = mock_provider()
            .send_with_fallback("dummy", &json!({"model":"gemini-3.8-flash-low"}), &[&primary, &secondary])
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        server.abort();
    }

    #[tokio::test]
    async fn quota_after_earlier_failures_names_them() {
        let (base, server) = endpoint_server(
            "/{endpoint}/v1internal:streamGenerateContent",
            |endpoint: String| match endpoint.as_str() {
                "primary" => (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    r#"{"error":"busy"}"#.to_string(),
                ),
                _ => (
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    r#"{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}"#
                        .to_string(),
                ),
            },
        )
        .await;
        let primary = format!("{base}/primary");
        let secondary = format!("{base}/secondary");
        let error = mock_provider()
            .send_with_fallback("dummy", &json!({"model":"gemini-3.8-flash-low"}), &[&primary, &secondary])
            .await
            .unwrap_err();
        match error {
            ProviderError::RateLimitExceeded { details, .. } => {
                assert!(details.contains("503"), "{details}");
                assert!(details.contains("primary"), "{details}");
            }
            other => panic!("expected RateLimitExceeded, got {other}"),
        }
        server.abort();
    }

    fn mock_provider() -> AntigravityProvider {
        AntigravityProvider {
            http: reqwest::Client::new(),
            session: Mutex::new(None),
            conversation_id: "test-conv".into(),
            trajectory_id: "test-traj".into(),
        }
    }

    #[tokio::test]
    async fn transient_failure_fails_over_without_changing_request() {
        use axum::{extract::Path, http::StatusCode, routing::post, Json, Router};
        let app = Router::new().route(
            "/{endpoint}/v1internal:streamGenerateContent",
            post(
                |Path(endpoint): Path<String>, Json(body): Json<Value>| async move {
                    if endpoint == "primary" {
                        (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({"error":"busy"})),
                        )
                    } else if body["request"]["sessionId"] == "test-session" {
                        (StatusCode::OK, Json(json!({"response":{"candidates":[]}})))
                    } else {
                        (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"error":"changed body"})),
                        )
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let primary = format!("http://{address}/primary");
        let secondary = format!("http://{address}/secondary");
        let result = mock_provider()
            .send_with_fallback(
                "dummy",
                &json!({"request":{"sessionId":"test-session"}}),
                &[&primary, &secondary],
            )
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::OK);
        server.abort();
    }

    #[tokio::test]
    async fn relay_sse_preserves_tool_call_thinking_and_usage() {
        let events = [
            json!({"response":{"candidates":[{"content":{"parts":[
                {"text":"considering the tool","thought":true,"thoughtSignature":"sig-test"},
                {"functionCall":{"id":"call-1","name":"shell","args":{"command":"true"}},"thoughtSignature":"sig-test"}
            ]}}]}}),
            json!({"response":{"candidates":[{"finishReason":"STOP"}],
                "usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}}),
        ];
        let lines = events
            .iter()
            .map(|event| Ok(unwrap_sse(&format!("data: {event}"))))
            .collect::<Vec<anyhow::Result<String>>>();
        let parsed = response_to_streaming_message(futures::stream::iter(lines))
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        assert!(parsed
            .iter()
            .filter_map(|(message, _)| message.as_ref())
            .flat_map(|message| &message.content)
            .any(|block| matches!(
                block,
                crate::conversation::message::MessageContentBlock::ToolRequest(_)
            )));
        assert!(parsed.iter().any(|(_, usage)| usage.is_some()));
    }

    #[tokio::test]
    async fn quota_exposes_retry_after() {
        use axum::{
            http::{header, StatusCode},
            routing::post,
            Router,
        };
        let app = Router::new().route(
            "/v1internal:streamGenerateContent",
            post(|| async {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [(header::RETRY_AFTER, "7")],
                    "quota",
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let endpoint = format!("http://{address}");
        let result = mock_provider()
            .send_with_fallback("dummy", &json!({}), &[&endpoint])
            .await
            .unwrap_err();
        assert!(
            matches!(result, ProviderError::RateLimitExceeded { retry_delay: Some(delay), .. }
            if delay == Duration::from_secs(7))
        );
        server.abort();
    }
}
