//! Extraccion de memoria al cierre del turno.
//!
//! Es una operacion nativa del harness, no un hook de plugin: al terminar un turno se toma el
//! ultimo par (pedido del operador, respuesta del agente), se lo pasa a un modelo barato con un
//! contrato JSON estricto y lo que vuelve se guarda como **candidato** (`status=candidate`,
//! `source=inferred`, confianza maxima 0,6). Un candidato no entra al prompt: se ve en el panel de
//! memoria, y pasa a confirmado cuando se repite en otra sesion o cuando el operador lo confirma.
//!
//! El extractor no inventa: si no hay señal explicita del operador devuelve `nothing_new`. Un turno
//! sin respuesta sustancial (menos de `MIN_ASSISTANT_CHARS`) no dispara llamada, para no pagar por
//! nada.

use crate::conversation::Conversation;
use crate::model_config::complete_one_shot;
use crate::providers::base::Provider;
use aegis_providers::model::ModelConfig;
use anyhow::Result;
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// Debajo de esto el turno no tuvo sustancia (un "ok", un error, una confirmacion de tool).
const MIN_ASSISTANT_CHARS: usize = 200;
/// Tope de hechos por turno: mas de tres en un turno es señal de que el extractor esta inventando.
const MAX_FACTS_PER_TURN: usize = 3;
const MAX_USER_CHARS: usize = 4_000;
const MAX_ASSISTANT_CHARS: usize = 6_000;
const SEEN_CAPACITY: usize = 256;

const SYSTEM_PROMPT: &str = r#"Sos un extractor de memoria de un operador tecnico. Leelo y devolve SOLO JSON.

Reglas:
- Extrae unicamente hechos DURABLES sobre el operador o su entorno: preferencias de estilo, decisiones
  tomadas y su motivo, datos de la maquina o del proyecto, objetivos en curso, reglas de trabajo.
- No extraigas estados transitorios (que archivo se edita, que build corre, que comando fallo), ni
  resumenes de la tarea, ni lo que dijo el agente: solo lo que dijo el operador.
- No inventes. Si el operador no declaro nada durable, devolve {"facts": [], "nothing_new": true}.
- Cada hecho: una frase corta en espanol, sin adornos, sin comillas internas.
- `confidence` entre 0 y 0.6: que tan seguro estas de que es durable y explicito.
- `quote`: la frase textual del operador que lo respalda (maximo 160 caracteres).
- Nada de credenciales, tokens, claves ni datos personales sensibles.

Formato exacto:
{"facts":[{"text":"...","kind":"preference|fact|goal|decision|style","confidence":0.5,"quote":"..."}],"nothing_new":false}"#;

#[derive(Debug, Deserialize)]
struct RawExtraction {
    #[serde(default)]
    facts: Vec<RawFact>,
    #[serde(default)]
    nothing_new: bool,
}

#[derive(Debug, Deserialize)]
struct RawFact {
    text: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    confidence: f32,
    #[serde(default)]
    quote: String,
}

static SEEN: Mutex<Option<VecDeque<String>>> = Mutex::new(None);

/// Activable por config (`AEGIS_MEMORY_EXTRACTION`), encendido por defecto.
pub fn enabled() -> bool {
    crate::config::Config::global()
        .get_param::<bool>("AEGIS_MEMORY_EXTRACTION")
        .unwrap_or(true)
}

fn model_override() -> Option<String> {
    crate::config::Config::global()
        .get_param::<String>("AEGIS_MEMORY_EXTRACT_MODEL")
        .ok()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
}

fn already_extracted(session_id: &str, marker: &str) -> bool {
    let key = format!("{session_id}:{marker}");
    let mut guard = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let seen = guard.get_or_insert_with(VecDeque::new);
    if seen.iter().any(|k| k == &key) {
        return true;
    }
    seen.push_back(key);
    while seen.len() > SEEN_CAPACITY {
        seen.pop_front();
    }
    false
}

struct TurnText {
    user: String,
    assistant: String,
    marker: String,
}

fn last_turn_text(conversation: &Conversation) -> Option<TurnText> {
    use rmcp::model::Role;

    let mut user = String::new();
    let mut assistant = String::new();
    let mut marker = String::new();

    for message in conversation.messages().iter().rev() {
        if !message.is_user_visible() {
            continue;
        }
        let text = message
            .content
            .iter()
            .filter_map(|c| c.as_text())
            .collect::<Vec<_>>()
            .join("\n");
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        match message.role {
            Role::Assistant if assistant.is_empty() => {
                assistant = text.to_string();
            }
            Role::User if user.is_empty() && !assistant.is_empty() => {
                user = text.to_string();
                marker = message
                    .id
                    .clone()
                    .unwrap_or_else(|| format!("len:{}", text.chars().count()));
                break;
            }
            _ => {}
        }
    }

    if user.is_empty() || assistant.is_empty() {
        return None;
    }
    Some(TurnText {
        user,
        assistant,
        marker,
    })
}

fn extract_json(raw: &str) -> Option<RawExtraction> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    let slice = raw.get(start..=end)?;
    serde_json::from_str::<RawExtraction>(slice).ok()
}

/// Aplica una respuesta del extractor al store. Separado de la llamada al modelo para poder
/// testearlo sin red.
pub fn apply(raw: &str, session_id: &str, path: &std::path::Path) -> Result<usize> {
    let Some(parsed) = extract_json(raw) else {
        return Ok(0);
    };
    if parsed.nothing_new {
        return Ok(0);
    }
    let mut written = 0usize;
    for fact in parsed.facts.iter().take(MAX_FACTS_PER_TURN) {
        if fact.text.trim().is_empty() {
            continue;
        }
        let kind = if fact.kind.trim().is_empty() {
            "fact"
        } else {
            fact.kind.trim()
        };
        if crate::memory::store::append_candidate(
            path,
            session_id,
            &fact.text,
            kind,
            fact.confidence,
            &fact.quote,
        )?
        .is_some()
        {
            written += 1;
        }
    }
    Ok(written)
}

/// Corre la extraccion de un turno. Devuelve cuantos hechos se tocaron.
pub async fn run_turn(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    conversation: &Conversation,
) -> Result<usize> {
    let Some(turn) = last_turn_text(conversation) else {
        return Ok(0);
    };
    if turn.assistant.chars().count() < MIN_ASSISTANT_CHARS {
        return Ok(0);
    }
    if already_extracted(session_id, &turn.marker) {
        return Ok(0);
    }

    let prompt = format!(
        "PEDIDO DEL OPERADOR:\n{}\n\nRESPUESTA DEL AGENTE (contexto, no es fuente de hechos):\n{}\n",
        crate::memory::store::truncate_chars(&turn.user, MAX_USER_CHARS),
        crate::memory::store::truncate_chars(&turn.assistant, MAX_ASSISTANT_CHARS),
    );
    let message = crate::conversation::message::Message::user().with_text(&prompt);
    let (reply, usage) = complete_one_shot(
        provider,
        model_config,
        session_id,
        SYSTEM_PROMPT,
        &[message],
        &[],
    )
    .await?;

    let raw: String = reply
        .content
        .iter()
        .filter_map(|c| c.as_text())
        .collect::<Vec<_>>()
        .join("");
    let path = crate::memory::store::store_path();
    let written = apply(&raw, session_id, &path)?;
    tracing::debug!(
        "memoria: extraccion del turno {} -> {} hechos ({} tok in / {} tok out)",
        session_id,
        written,
        usage.usage.input_tokens.unwrap_or(0),
        usage.usage.output_tokens.unwrap_or(0),
    );
    Ok(written)
}

/// Dispara la extraccion desprendida del turno: el usuario ya tiene su respuesta y esto corre
/// despues. Cualquier error se loguea y no se propaga.
///
/// Decide si hay un extractor propio, sin tocar red ni config: la politica pura.
/// `AEGIS_MEMORY_EXTRACT_MODEL` se valida contra el provider de la sesion, asi que
/// con la sesion en otro proveedor el override se descartaba en silencio; el knob
/// `AEGIS_MEMORY_EXTRACT_PROVIDER` levanta un provider aparte para que el trabajo
/// repetido corra en un modelo barato sin mover el proveedor de la sesion.
fn extractor_choice(provider: Option<&str>, model: Option<&str>) -> Option<(String, String)> {
    let provider = provider?.trim();
    let model = model?.trim();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider.to_string(), model.to_string()))
}

async fn extractor_provider() -> Option<(Arc<dyn Provider>, String)> {
    let provider_name = crate::config::Config::global()
        .get_param::<String>("AEGIS_MEMORY_EXTRACT_PROVIDER")
        .ok();
    let model = model_override();
    let (name, model) = extractor_choice(provider_name.as_deref(), model.as_deref())?;
    match crate::providers::create(&name, Vec::new()).await {
        Ok(provider) => Some((provider, model)),
        Err(error) => {
            tracing::debug!("memoria: no se pudo crear el provider '{name}': {error}");
            None
        }
    }
}

async fn pick_extractor(
    provider: Arc<dyn Provider>,
    model_config: ModelConfig,
) -> (Arc<dyn Provider>, ModelConfig) {
    if let Some((own_provider, model)) = extractor_provider().await {
        let name = own_provider.get_name().to_string();
        match crate::model_config::model_config_from_user_config(&name, &model) {
            Ok(config) => return (own_provider, config),
            Err(error) => tracing::debug!(
                "memoria: modelo de extraccion '{model}' invalido en '{name}': {error}"
            ),
        }
    }
    let model_config = match model_override() {
        Some(model) => match crate::model_config::model_config_from_user_config(
            provider.get_name(),
            &model,
        ) {
            Ok(config) => config,
            Err(error) => {
                tracing::debug!("memoria: modelo de extraccion '{model}' invalido: {error}");
                model_config
            }
        },
        None => model_config,
    };
    (provider, model_config)
}

pub fn spawn(provider: Arc<dyn Provider>, model_config: ModelConfig, session_id: String) {
    tokio::spawn(async move {
        if !enabled() {
            return;
        }
        let (provider, model_config) = pick_extractor(provider, model_config).await;

        let manager = crate::session::SessionManager::instance();
        let session = match manager.get_session(&session_id, true).await {
            Ok(session) => session,
            Err(error) => {
                tracing::debug!("memoria: sin sesion para extraer ({session_id}): {error}");
                return;
            }
        };
        let Some(conversation) = session.conversation.as_ref() else {
            return;
        };
        if let Err(error) =
            run_turn(provider.as_ref(), &model_config, &session_id, conversation).await
        {
            tracing::debug!("memoria: extraccion fallo en {session_id}: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extractor_choice_needs_both_knobs() {
        assert_eq!(
            extractor_choice(Some("chatgpt_codex"), Some("gpt-6-luna")),
            Some(("chatgpt_codex".to_string(), "gpt-6-luna".to_string()))
        );
        assert!(extractor_choice(None, Some("gpt-6-luna")).is_none());
        assert!(extractor_choice(Some("chatgpt_codex"), None).is_none());
        assert!(extractor_choice(Some("  "), Some("gpt-6-luna")).is_none());
        assert!(extractor_choice(Some("chatgpt_codex"), Some("")).is_none());
    }

    #[tokio::test]
    #[ignore = "toca el config del store y el registry de providers: se corre a mano para verificar"]
    async fn extractor_provider_levanta_el_provider_configurado() {
        let provider_name = crate::config::Config::global()
            .get_param::<String>("AEGIS_MEMORY_EXTRACT_PROVIDER")
            .ok();
        let model = model_override();
        let Some((name, model)) = extractor_choice(provider_name.as_deref(), model.as_deref()) else {
            eprintln!("VERIFICA: sin knobs configurados, no hay extractor propio");
            return;
        };
        match crate::providers::create(&name, Vec::new()).await {
            Ok(provider) => eprintln!(
                "VERIFICA: provider='{}' model='{model}' se construyo",
                provider.get_name()
            ),
            Err(error) => eprintln!("VERIFICA: FALLO create('{name}'): {error}"),
        }
    }

    #[test]
    fn extractor_choice_trims_values() {
        assert_eq!(
            extractor_choice(Some(" chatgpt_codex "), Some(" gpt-6-luna ")),
            Some(("chatgpt_codex".to_string(), "gpt-6-luna".to_string()))
        );
    }

    use crate::memory::store;
    use tempfile::TempDir;

    #[test]
    fn parses_json_inside_prose_and_writes_candidates() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("facts.jsonl");
        let raw = r#"Claro, aca va:
{"facts":[{"text":"Prefiere commits sin firma de IA","kind":"preference","confidence":0.9,"quote":"sin firma de IA"}],"nothing_new":false}"#;
        assert_eq!(apply(raw, "20261026_1", &path).unwrap(), 1);
        let facts = store::read_from(&path);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].status, store::Status::Candidate);
        assert!(facts[0].confidence <= store::CANDIDATE_CONFIDENCE_CEILING);
        assert_eq!(facts[0].source, store::Source::Inferred);
        assert!(facts[0].evidence[0].starts_with("20261026_1: sin firma"));
    }

    #[test]
    fn respects_nothing_new_and_garbage() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("facts.jsonl");
        assert_eq!(apply("no hay json", "s", &path).unwrap(), 0);
        assert_eq!(
            apply(r#"{"facts":[],"nothing_new":true}"#, "s", &path).unwrap(),
            0
        );
        assert!(store::read_from(&path).is_empty());
    }

    #[test]
    fn caps_three_facts_per_turn() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("facts.jsonl");
        let facts = (1..=5)
            .map(|i| {
                format!(r#"{{"text":"hecho {i}","kind":"fact","confidence":0.4,"quote":"q"}}"#)
            })
            .collect::<Vec<_>>()
            .join(",");
        apply(
            &format!(r#"{{"facts":[{facts}],"nothing_new":false}}"#),
            "s",
            &path,
        )
        .unwrap();
        assert_eq!(store::read_from(&path).len(), 3);
    }

    #[test]
    fn an_existing_confirmed_fact_is_not_duplicated() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("facts.jsonl");
        store::upsert_declared(
            &path,
            "s1",
            "Prefiere espanol rioplatense",
            "style",
            vec![],
            0.9,
            false,
        )
        .unwrap();
        apply(
            r#"{"facts":[{"text":"prefiere español rioplatense","kind":"style","confidence":0.6,"quote":"q"}],"nothing_new":false}"#,
            "s2",
            &path,
        )
        .unwrap();
        let facts = store::read_from(&path);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].status, store::Status::Confirmed);
        assert!(facts[0].evidence.len() >= 2);
    }
}
