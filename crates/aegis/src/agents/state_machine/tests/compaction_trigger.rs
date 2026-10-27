//! Path B del diagnostico de compactacion (docs\aegis-harness-estudio.md §17.19):
//! la operacion de compactacion ejercitada con una conversacion sintetica y el
//! limite de contexto inyectado. Sin red y sin store: el provider contesta un
//! resumen fijo y el contexto se construye a mano.
//!
//! El caso que motiva el diagnostico es el de produccion: la ultima inferencia
//! reporto un uso chico (o ninguno) y despues entraron resultados de herramientas
//! grandes, asi que `session.usage.total_tokens` no representa el contexto real.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::Result;
use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agents::state_machine::{AegisEffect, CompactionOperation, Emitter, Operation};
use crate::agents::AgentEvent;
use crate::context_mgmt::count_context_tokens;
use crate::conversation::message::Message;
use crate::conversation::Conversation;
use crate::providers::base::{stream_from_single_message, MessageStream, Provider};
use crate::session::Session;
use aegis_providers::conversation::token_usage::{ProviderUsage, Usage};
use aegis_providers::errors::ProviderError;
use aegis_providers::model::ModelConfig;

const MODEL: &str = "scripted-model";
const THRESHOLD: f64 = 0.35;
const NOTICE: &str = "Exceeded auto-compact threshold";

/// `validate` en el motor de compactacion rechaza resumenes de menos de 100
/// caracteres para entradas de mas de 2.000 tokens.
const SUMMARY_TEXT: &str = "Resumen estructurado del tramo compactado: el operador pidio leer los archivos \
del proyecto, la herramienta devolvio el contenido y el run siguio desde este resumen.";

const WORDS: [&str; 16] = [
    "contexto", "operacion", "resultado", "archivo", "linea", "error", "sesion", "turno", "medicion",
    "registro", "bloque", "valor", "indice", "cadena", "proceso", "limite",
];

fn build_words(count: usize) -> String {
    let mut text = String::with_capacity(count * 8);
    for index in 0..count {
        text.push_str(WORDS[index % WORDS.len()]);
        text.push(' ');
    }
    text
}

/// Texto de al menos `min_tokens` tokens segun el mismo contador que usa la
/// operacion. Una sola medicion de mas: las palabras de la lista son comunes y
/// el BPE las deja en ~1 token cada una.
async fn text_with_tokens(min_tokens: usize) -> String {
    let counter = crate::token_counter::shared_token_counter()
        .await
        .expect("token counter");
    let mut text = build_words(min_tokens);
    let counted = counter.count_tokens(&text);
    if counted < min_tokens {
        text.push_str(&build_words(min_tokens - counted));
    }
    text
}

struct Outcome {
    compacted: bool,
    notice: Option<String>,
    summary_calls: usize,
}

struct SummaryProvider {
    limit: usize,
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl Provider for SummaryProvider {
    fn get_name(&self) -> &str {
        "compaction-trigger-test"
    }

    async fn get_context_limit(&self, _model: &str, _override_limit: Option<usize>) -> usize {
        self.limit
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        _system: &str,
        _messages: &[Message],
        _tools: &[rmcp::model::Tool],
    ) -> Result<MessageStream, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(stream_from_single_message(
            Message::assistant().with_text(SUMMARY_TEXT),
            ProviderUsage::new(
                model_config.model_name.clone(),
                Usage::new(Some(1_000), Some(120), Some(1_120)),
            ),
        ))
    }
}

async fn evaluate(
    conversation: &Conversation,
    reported_total: Option<i32>,
    limit: usize,
    threshold: f64,
) -> Result<Outcome> {
    let provider = Arc::new(SummaryProvider {
        limit,
        calls: AtomicUsize::new(0),
    });
    let operation = CompactionOperation::new(
        provider.clone(),
        ModelConfig::new(MODEL),
        limit,
        threshold,
    );

    let session = Session {
        id: "compaction-trigger".to_string(),
        usage: Usage::new(reported_total, Some(0), reported_total),
        ..Session::default()
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let emit = Emitter::new(tx, CancellationToken::new());
    let result = operation.run(&session, conversation, &emit).await?;

    let compacted = match &result {
        crate::agents::state_machine::OperationResult::Applied(step) => step
            .effects
            .iter()
            .any(|effect| matches!(effect, AegisEffect::CompactConversation { .. })),
        crate::agents::state_machine::OperationResult::NotApplicable => false,
    };

    let mut notice = None;
    while let Ok(event) = rx.try_recv() {
        if let AgentEvent::Message(message) = event {
            if let Some(text) = message.content.iter().find_map(|content| {
                content
                    .as_system_notification()
                    .filter(|notification| notification.msg.contains(NOTICE))
                    .map(|notification| notification.msg.clone())
            }) {
                notice = Some(text);
            }
        }
    }

    Ok(Outcome {
        compacted,
        notice,
        summary_calls: provider.calls.load(Ordering::SeqCst),
    })
}

/// Un turno con contexto real por encima del techo tiene que compactar aunque el
/// uso reportado por la ultima inferencia sea chico. Es el caso de produccion:
/// el resultado de herramienta entra despues de la inferencia que lo pidio.
#[tokio::test]
async fn auto_compaction_fires_on_the_counted_context_not_the_reported_usage() -> Result<()> {
    let limit = 200_000;
    let ceiling = (limit as f64 * THRESHOLD) as usize; // 70k

    let mut messages = vec![Message::user().with_text("lee los archivos del proyecto y resumilos")];
    for index in 0..10 {
        let output = text_with_tokens(10_000).await;
        messages.push(
            Message::assistant()
                .with_tool_request(format!("call-{index}"), Ok(CallToolRequestParams::new("read_file"))),
        );
        messages.push(Message::user().with_tool_response(
            format!("call-{index}"),
            Ok(CallToolResult::success(vec![ContentBlock::text(output)])),
        ));
    }
    let conversation = Conversation::new_unvalidated(messages);

    let counted = count_context_tokens(conversation.messages()).await?;
    assert!(
        counted as usize > ceiling,
        "el contexto sintetico tiene que superar el techo: {counted} <= {ceiling}"
    );

    let outcome = evaluate(
        &conversation,
        Some(1_200), // lo que reportaria una inferencia que solo vio la cola nueva
        limit,
        THRESHOLD,
    )
    .await?;

    assert!(
        outcome.notice.is_some(),
        "un contexto contado de {counted} tokens contra un techo de {ceiling} tiene que avisar"
    );
    assert!(outcome.compacted, "tiene que emitir AegisEffect::CompactConversation");
    assert!(outcome.summary_calls > 0, "la compactacion tiene que llegar a resumir");
    Ok(())
}

/// Guarda del criterio de aceptacion: 195k de contexto con techo de 350k no
/// compacta.
#[tokio::test]
async fn auto_compaction_stays_quiet_under_the_ceiling() -> Result<()> {
    let limit = 1_000_000;
    let ceiling = (limit as f64 * THRESHOLD) as usize; // 350k

    let mut messages = vec![Message::user().with_text("arranca el trabajo")];
    for index in 0..20 {
        let output = text_with_tokens(9_700).await;
        messages.push(
            Message::assistant()
                .with_tool_request(format!("call-{index}"), Ok(CallToolRequestParams::new("read_file"))),
        );
        messages.push(Message::user().with_tool_response(
            format!("call-{index}"),
            Ok(CallToolResult::success(vec![ContentBlock::text(output)])),
        ));
    }
    let conversation = Conversation::new_unvalidated(messages);

    let counted = count_context_tokens(conversation.messages()).await?;
    assert!(
        (counted as usize) < ceiling,
        "el contexto sintetico tiene que quedar por debajo del techo: {counted} >= {ceiling}"
    );

    let outcome = evaluate(&conversation, Some(counted), limit, THRESHOLD).await?;
    assert!(!outcome.compacted, "195k contra un techo de 350k no compacta");
    assert!(outcome.notice.is_none());
    Ok(())
}

/// El uso reportado sigue mandando cuando es mayor que lo contado: con 400k
/// reportados, el techo de 350k se pasa y la compactacion ocurre.
#[tokio::test]
async fn reported_usage_over_the_ceiling_compacts() -> Result<()> {
    let limit = 1_000_000;
    let conversation = Conversation::new_unvalidated([
        Message::user().with_text("trabajo en curso"),
        Message::assistant().with_text("seguimos"),
        Message::user().with_text("continue"),
    ]);

    let outcome = evaluate(&conversation, Some(400_000), limit, THRESHOLD).await?;
    assert!(outcome.compacted);
    assert!(outcome.notice.is_some_and(|notice| notice.contains("350k")));
    Ok(())
}

/// Sin uso reportado la operacion cae al conteo del contexto y dispara.
#[tokio::test]
async fn missing_reported_usage_falls_back_to_the_count() -> Result<()> {
    let limit = 200_000;
    let mut messages = vec![Message::user().with_text("lee y resume")];
    for index in 0..8 {
        let output = text_with_tokens(10_000).await;
        messages.push(
            Message::assistant()
                .with_text("leyendo")
                .with_tool_request(format!("call-{index}"), Ok(CallToolRequestParams::new("read_file"))),
        );
        messages.push(Message::user().with_tool_response(
            format!("call-{index}"),
            Ok(CallToolResult::success(vec![ContentBlock::text(output)])),
        ));
    }
    let conversation = Conversation::new_unvalidated(messages);

    let outcome = evaluate(&conversation, None, limit, THRESHOLD).await?;
    assert!(outcome.compacted);
    assert!(outcome.notice.is_some());
    Ok(())
}
