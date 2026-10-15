//! Retries when the provider's stream dies before any output reached the user.
//!
//! Real incident (session `20261011_5`, Open Design/DeepSeek behind a gateway):
//! the SSE body was cut a few seconds in, nothing had been shown yet, and the
//! turn died with `Stream decode error: error decoding response body`. The very
//! same request is safe to re-send in that state, so the runner now does it.
//!
//! The rules mirror the legacy agent path (`stream_response_from_provider` in
//! `aegis::agents::reply_parts`): the provider's own retry policy, transient
//! errors only, providers that manage their own context opt out, and a stream
//! that already produced visible output is never replayed.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use futures::stream;
use aegis_agent::inference::{InferenceEffect, InferenceRunner};
use aegis_agent::operation::{Emitter, Inference, InferenceInput, OperationResult};
use aegis_provider_types::base::{MessageStream, Provider};
use aegis_provider_types::conversation::message::{Message, MessageContent};
use aegis_provider_types::conversation::token_usage::{ProviderUsage, Usage};
use aegis_provider_types::conversation::Conversation;
use aegis_provider_types::errors::ProviderError;
use aegis_provider_types::model::ModelConfig;
use aegis_provider_types::retry::RetryConfig;
use rmcp::model::Tool;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const CUT_STREAM: &str =
    "Stream decode error: error decoding response body: connection reset by peer";

#[derive(Debug)]
enum Effect {
    Message(Message),
    Usage,
}

impl From<Message> for Effect {
    fn from(message: Message) -> Self {
        Effect::Message(message)
    }
}

impl InferenceEffect for Effect {
    fn record_usage(_usage: ProviderUsage) -> Self {
        Effect::Usage
    }
}

/// Fails the first `failures` calls, then replies.
struct FlakyProvider {
    failures: usize,
    error: ProviderError,
    calls: Arc<AtomicUsize>,
    manages_context: bool,
}

impl FlakyProvider {
    fn new(failures: usize, error: ProviderError, calls: Arc<AtomicUsize>) -> Self {
        Self {
            failures,
            error,
            calls,
            manages_context: false,
        }
    }

    fn managing_context(mut self) -> Self {
        self.manages_context = true;
        self
    }
}

#[async_trait]
impl Provider for FlakyProvider {
    fn get_name(&self) -> &str {
        "flaky"
    }

    /// Same shape as the legacy agent-path test provider: two retries, no wait.
    fn retry_config(&self) -> RetryConfig {
        RetryConfig::new(2, 0, 1.0, 0)
    }

    fn manages_own_context(&self) -> bool {
        self.manages_context
    }

    async fn stream(
        &self,
        _model_config: &ModelConfig,
        _system: &str,
        _messages: &[Message],
        _tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call < self.failures {
            return Err(self.error.clone());
        }

        let usage = ProviderUsage::new("flaky-model".to_string(), Usage::default());
        Ok(Box::pin(stream::once(async move {
            Ok((Some(Message::assistant().with_text("listo")), Some(usage)))
        })))
    }
}

/// Emits one visible chunk and then dies, like a stream cut mid-answer.
struct CutMidAnswerProvider {
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl Provider for CutMidAnswerProvider {
    fn get_name(&self) -> &str {
        "cut-mid-answer"
    }

    fn retry_config(&self) -> RetryConfig {
        RetryConfig::new(2, 0, 1.0, 0)
    }

    async fn stream(
        &self,
        _model_config: &ModelConfig,
        _system: &str,
        _messages: &[Message],
        _tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Box::pin(stream::iter(vec![
            Ok((
                Some(Message::assistant().with_text("parcial")),
                None::<ProviderUsage>,
            )),
            Err(ProviderError::NetworkError(CUT_STREAM.to_string())),
        ])))
    }
}

fn text_of(message: &Message) -> Option<String> {
    message.content.iter().find_map(|content| match content {
        MessageContent::Text(text) => Some(text.text.clone()),
        // Provider failures land as an error block, not as text.
        MessageContent::Error(error) => Some(error.message.clone()),
        _ => None,
    })
}

fn emitted_texts(result: OperationResult<Effect>) -> Vec<String> {
    let OperationResult::Applied(step) = result else {
        panic!("expected the inference to apply");
    };
    step.effects
        .into_iter()
        .filter_map(|effect| match effect {
            Effect::Message(message) => text_of(&message),
            Effect::Usage => None,
        })
        .collect()
}

async fn infer_once(provider: Arc<dyn Provider>) -> Vec<String> {
    let runner = InferenceRunner::<(), Effect>::new(provider, ModelConfig::new("flaky-model"));
    let cancel = CancellationToken::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    let emit = Emitter::new(tx, cancel);
    let conversation = Conversation::new_unvalidated([Message::user().with_text("hola")]);

    let result = runner
        .infer(&(), &conversation, InferenceInput::default(), &emit)
        .await
        .expect("a provider failure should land as effects, not as an error");

    emitted_texts(result)
}

fn cut_stream_error() -> ProviderError {
    ProviderError::NetworkError(CUT_STREAM.to_string())
}

#[tokio::test]
async fn retries_the_same_request_when_the_stream_dies_before_any_output() {
    let calls = Arc::new(AtomicUsize::new(0));

    let texts = infer_once(Arc::new(FlakyProvider::new(
        1,
        cut_stream_error(),
        calls.clone(),
    )))
    .await;

    assert_eq!(texts, vec!["listo".to_string()]);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "one retry after the single cut stream"
    );
}

#[tokio::test]
async fn gives_up_after_the_configured_retries_and_surfaces_the_error() {
    let calls = Arc::new(AtomicUsize::new(0));

    let texts = infer_once(Arc::new(FlakyProvider::new(
        usize::MAX,
        cut_stream_error(),
        calls.clone(),
    )))
    .await;

    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "1 attempt plus the 2 configured retries"
    );
    assert_eq!(texts.len(), 1, "only the error message is stored");
    assert!(texts[0].contains("Stream decode error"));
    assert!(texts[0].contains("Please resend your message to try again"));
}

#[tokio::test]
async fn never_retries_once_output_reached_the_screen() {
    let calls = Arc::new(AtomicUsize::new(0));

    let texts = infer_once(Arc::new(CutMidAnswerProvider {
        calls: calls.clone(),
    }))
    .await;

    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "retrying with content already emitted would duplicate it"
    );
    assert_eq!(texts[0], "parcial");
    assert!(texts[1].contains("Please resend your message to try again"));
}

#[tokio::test]
async fn a_provider_that_manages_its_own_context_is_never_retried() {
    let calls = Arc::new(AtomicUsize::new(0));

    let texts = infer_once(Arc::new(
        FlakyProvider::new(1, cut_stream_error(), calls.clone()).managing_context(),
    ))
    .await;

    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "re-running it could duplicate work"
    );
    assert!(texts[0].contains("Stream decode error"));
}

#[tokio::test]
async fn a_non_transient_error_is_not_retried() {
    let calls = Arc::new(AtomicUsize::new(0));

    let texts = infer_once(Arc::new(FlakyProvider::new(
        1,
        ProviderError::ContextLengthExceeded("too long".into()),
        calls.clone(),
    )))
    .await;

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(texts[0].contains("too long"));
}
