use anyhow::{bail, Result};
use aegis_provider_types::conversation::message::Message;
use aegis_provider_types::conversation::token_usage::ProviderUsage;
use serde::Serialize;
use std::collections::VecDeque;

use crate::format::format_message_for_compacting;
use crate::model::{CompactionModel, TokenEstimator};
use crate::summarize::{summarize_with_policy, Summary};
use crate::templates::{render, Templates};

const MAX_STAGES: usize = 8;
const MAX_REQUESTS: usize = 128;

#[derive(Serialize)]
struct ChunkContext {
    messages: String,
}

async fn input_tokens(
    estimator: &dyn TokenEstimator,
    templates: &Templates,
    formatted: &[String],
) -> Result<usize> {
    let system = render(
        &templates.compaction,
        &ChunkContext {
            messages: formatted.join("\n"),
        },
    )?;
    let request = [Message::user()
        .with_text("Please summarize the conversation history provided in the system prompt.")];
    Ok(estimator.count_chat_tokens(&system, &request).await)
}

/// Validation failures that shrink when the batch gets smaller. Splitting the
/// batch beats aborting the whole compaction: the caller only persists a
/// replacement when every batch succeeds.
///
/// Every failure here must also be *recoverable* where possible: the messages are
/// checked before the format, because a truncated response is fixed by a smaller
/// batch, while an unformatted-but-complete response is fixed by using its raw
/// text. Only text that cannot carry the batch (empty, or implausibly short for
/// its input) aborts the compaction.
fn is_budget_failure(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}");
    text.contains("output limit") || text.contains("configured budget")
}

fn validate(summary: &Summary, input: usize, output_budget: usize) -> Result<()> {
    let text = summary.message.as_concat_text();
    if text.trim().is_empty() {
        bail!("Compaction returned an empty summary");
    }
    // Truncation is diagnosed before the output format. A response cut off mid-JSON is
    // what a large batch usually produces (the model reviews the batch in its thinking
    // and runs out of output budget before the fence closes), and its recovery is the
    // batch split - reporting it as "malformed" aborted the whole compaction instead.
    if summary
        .usage
        .finish_reasons
        .as_ref()
        .is_some_and(|reasons| {
            reasons.iter().any(|reason| {
                let reason = reason.to_ascii_lowercase();
                reason.contains("max_token")
                    || reason.contains("length")
                    || reason.contains("truncat")
            })
        })
    {
        bail!("Compaction response ended at the output limit; original context preserved");
    }
    if summary.usage.usage.output_tokens.is_some_and(|tokens| {
        tokens > 0 && output_budget > 0 && (tokens as usize) >= output_budget.saturating_sub(32)
    }) {
        bail!("Compaction output filled the configured budget; original context preserved");
    }
    if input > 2_000 && text.chars().count() < 100 {
        bail!("Compaction summary is implausibly short for its input; original context preserved");
    }
    // A complete response that ignored the JSON contract is not a failure: it is the
    // raw-text fallback (see apply_structured_summary) and the batch it replaces is
    // already gone from the returned summary. Refusing it here aborted a /compact that
    // every other check considered usable. The caller logs it as a warning.
    Ok(())
}

/// Multi-stage compaction. Every source message must be covered by a batch;
/// neither oversized batches nor provider context errors may silently discard
/// messages. The caller persists a replacement only if the entire pipeline succeeds.
pub async fn summarize_in_chunks(
    model: &dyn CompactionModel,
    estimator: &dyn TokenEstimator,
    templates: &Templates,
    messages: &[Message],
    input_budget: usize,
    output_budget: usize,
) -> Result<Summary> {
    if messages.is_empty() {
        bail!("Cannot compact an empty visible history");
    }
    if input_budget == 0 {
        bail!("Compaction input budget must be positive");
    }
    let mut working = messages.to_vec();
    let mut accumulated: Option<ProviderUsage> = None;
    let mut requests = 0;
    for stage in 0..MAX_STAGES {
        let formatted: Vec<String> = working.iter().map(format_message_for_compacting).collect();
        let mut pending = VecDeque::new();
        let mut cursor = 0;
        while cursor < working.len() {
            let mut end = cursor;
            let mut chars: usize = 0;
            while end < working.len() {
                let size = formatted[end].chars().count();
                if end > cursor && chars.saturating_add(size) > input_budget.saturating_mul(3) {
                    break;
                }
                chars = chars.saturating_add(size);
                end += 1;
            }
            while end > cursor + 1
                && input_tokens(estimator, templates, &formatted[cursor..end]).await? > input_budget
            {
                end -= 1;
            }
            if input_tokens(estimator, templates, &formatted[cursor..end]).await? > input_budget {
                bail!("One history message exceeds the compaction input budget; original context preserved");
            }
            pending.push_back((cursor, end));
            cursor = end;
        }

        let mut next = Vec::new();
        let mut final_structured = false;
        while let Some((start, end)) = pending.pop_front() {
            requests += 1;
            if requests > MAX_REQUESTS {
                bail!("Compaction exceeded its request limit; original context preserved");
            }
            let input = input_tokens(estimator, templates, &formatted[start..end]).await?;
            match summarize_with_policy(
                model,
                Some(estimator),
                templates,
                &working[start..end],
                false,
            )
            .await
            {
                Ok(summary) => match validate(&summary, input, output_budget) {
                    Ok(()) => {
                        if let Some(total) = &mut accumulated {
                            total.usage += summary.usage.usage;
                            if let Some(cost) = summary.usage.cost {
                                total.cost = Some(total.cost.unwrap_or(0.0) + cost);
                            }
                        } else {
                            accumulated = Some(summary.usage.clone());
                        }
                        if !summary.structured {
                            tracing::warn!(
                                stage = stage + 1,
                                start,
                                end,
                                chars = summary.message.as_concat_text().chars().count(),
                                "Compaction batch ignored the structured format; keeping its raw text"
                            );
                        }
                        final_structured = summary.structured;
                        next.push(summary.message);
                    }
                    Err(error) if is_budget_failure(&error) && end - start > 1 => {
                        // A summary that filled its output budget shrinks with the
                        // batch, so splitting covers the same history in two shorter
                        // summaries instead of aborting the whole compaction.
                        tracing::warn!(
                            stage = stage + 1,
                            start,
                            end,
                            error = %error,
                            "Compaction summary filled its output budget; splitting the batch"
                        );
                        let middle = start + (end - start) / 2;
                        pending.push_front((middle, end));
                        pending.push_front((start, middle));
                    }
                    Err(error) => {
                        return Err(error.context(format!(
                            "Compaction stage {} batch {}..{}",
                            stage + 1,
                            start,
                            end
                        )))
                    }
                },
                Err(error)
                    if error
                        .to_string()
                        .contains("chunk exceeded effective context")
                        && end - start > 1 =>
                {
                    let middle = start + (end - start) / 2;
                    pending.push_front((middle, end));
                    pending.push_front((start, middle));
                }
                Err(error) => {
                    tracing::warn!(
                        stage = stage + 1,
                        start,
                        end,
                        error = %format!("{error:#}"),
                        "Compaction batch failed; original context preserved"
                    );
                    return Err(error.context(format!(
                        "Compaction stage {} batch {}..{}; original context preserved",
                        stage + 1,
                        start,
                        end
                    )));
                }
            }
        }
        if next.len() == 1 {
            return Ok(Summary {
                message: next.pop().expect("one result"),
                usage: accumulated.expect("one completed request"),
                structured: final_structured,
            });
        }
        if next.len() >= working.len() {
            let before: usize = formatted.iter().map(String::len).sum();
            let after: usize = next
                .iter()
                .map(|message| message.as_concat_text().len())
                .sum();
            if after >= before {
                bail!("Compaction did not reduce the blocks or their size; original context preserved");
            }
        }
        working = next;
    }
    bail!("Compaction exceeded its stage limit; original context preserved")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CompactionModel;
    use async_trait::async_trait;
    use aegis_provider_types::conversation::token_usage::Usage;
    use aegis_provider_types::errors::ProviderError;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeEstimator;
    #[async_trait]
    impl TokenEstimator for FakeEstimator {
        async fn count_chat_tokens(&self, system: &str, _: &[Message]) -> usize {
            system.chars().count() / 4
        }
        async fn count_text_tokens(&self, text: &str) -> usize {
            text.chars().count() / 4
        }
    }

    struct FakeModel {
        calls: AtomicUsize,
        malformed: bool,
    }
    #[async_trait]
    impl CompactionModel for FakeModel {
        async fn complete(
            &self,
            system: &str,
            _: &[Message],
        ) -> Result<(Message, ProviderUsage), ProviderError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let output = if self.malformed {
                "{".to_string()
            } else {
                let markers: Vec<_> = ('A'..='L')
                    .filter(|letter| {
                        system.contains(&format!("sentinel-{letter}"))
                            || system.contains(&format!("|{letter}|"))
                    })
                    .collect();
                serde_json::json!({"user_intent": [format!("Saved markers: {}", markers.iter().map(|letter| format!("|{letter}|")).collect::<String>())], "pending_tasks": ["retain original archive"]}).to_string()
            };
            Ok((
                Message::assistant().with_text(output),
                ProviderUsage::new("fake".into(), Usage::new(Some(100), Some(20), Some(120))),
            ))
        }
    }

    #[tokio::test]
    async fn multi_stage_covers_every_batch_and_accumulates_usage() {
        let model = FakeModel {
            calls: AtomicUsize::new(0),
            malformed: false,
        };
        let messages = ('A'..='L')
            .map(|letter| {
                Message::user().with_text(format!("sentinel-{letter} {}", "x".repeat(120)))
            })
            .collect::<Vec<_>>();
        let minimum = input_tokens(
            &FakeEstimator,
            &Templates::default(),
            &[format_message_for_compacting(&messages[0])],
        )
        .await
        .unwrap();
        let result = summarize_in_chunks(
            &model,
            &FakeEstimator,
            &Templates::default(),
            &messages,
            minimum + 110,
            8192,
        )
        .await
        .unwrap();
        assert!(model.calls.load(Ordering::Relaxed) > 1);
        assert!(result.usage.usage.input_tokens.unwrap() > 100);
        for letter in 'A'..='L' {
            assert!(
                result
                    .message
                    .as_concat_text()
                    .contains(&format!("|{letter}|")),
                "lost marker {letter}"
            );
        }
    }

    #[test]
    fn budget_failures_are_recognised_from_the_chain() {
        let budget = anyhow::anyhow!(
            "Compaction output filled the configured budget; original context preserved"
        );
        let truncated = anyhow::anyhow!(
            "Compaction response ended at the output limit; original context preserved"
        );
        let malformed = anyhow::anyhow!("Compaction returned an empty summary");
        assert!(is_budget_failure(&budget));
        assert!(is_budget_failure(&truncated));
        assert!(!is_budget_failure(&malformed));
    }

    /// A model that fills its output budget on every multi-message batch.
    struct BudgetFillingModel {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl CompactionModel for BudgetFillingModel {
        async fn complete(
            &self,
            system: &str,
            _: &[Message],
        ) -> Result<(Message, ProviderUsage), ProviderError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let sentinels = ('A'..='L')
                .filter(|letter| system.contains(&format!("sentinel-{letter}")))
                .count();
            let output_tokens = if sentinels > 1 { 8192 } else { 20 };
            let output = serde_json::json!({
                "user_intent": ["trabajo en curso"],
                "pending_tasks": ["pendiente"]
            })
            .to_string();
            Ok((
                Message::assistant().with_text(output),
                ProviderUsage::new(
                    "fake".into(),
                    Usage::new(Some(100), Some(output_tokens), Some(100 + output_tokens)),
                ),
            ))
        }
    }

    #[tokio::test]
    async fn batch_that_fills_the_output_budget_is_split_not_aborted() {
        let model = BudgetFillingModel {
            calls: AtomicUsize::new(0),
        };
        let messages = ('A'..='D')
            .map(|letter| {
                Message::user().with_text(format!("sentinel-{letter} {}", "x".repeat(400)))
            })
            .collect::<Vec<_>>();
        let minimum = input_tokens(
            &FakeEstimator,
            &Templates::default(),
            &[format_message_for_compacting(&messages[0])],
        )
        .await
        .unwrap();

        let result = summarize_in_chunks(
            &model,
            &FakeEstimator,
            &Templates::default(),
            &messages,
            minimum + 110,
            8192,
        )
        .await
        .expect("splitting the batch must keep the compaction alive");

        assert!(
            model.calls.load(Ordering::Relaxed) > 1,
            "the oversized batches must have been split"
        );
        assert!(result.message.as_concat_text().contains("trabajo en curso"));
    }

    #[tokio::test]
    async fn garbage_output_refuses_to_replace_large_history() {
        let model = FakeModel {
            calls: AtomicUsize::new(0),
            malformed: true,
        };
        let messages = vec![Message::user().with_text("x".repeat(9_000))];
        let error = summarize_in_chunks(
            &model,
            &FakeEstimator,
            &Templates::default(),
            &messages,
            8_000,
            8192,
        )
        .await
        .unwrap_err();
        let chain = format!("{error:#}");
        assert!(chain.contains("implausibly short"), "{chain}");
    }

    /// A model that answers the compaction prompt with prose (schema-ignoring model,
    /// or one that never emitted the fence).
    struct ProseModel {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl CompactionModel for ProseModel {
        async fn complete(
            &self,
            _system: &str,
            _: &[Message],
        ) -> Result<(Message, ProviderUsage), ProviderError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let output = "The session fixed the context popover clamp in app.js and committed it; \
                          the open work is the compact path, verified with node --check plus a \
                          check of the served file."
                .to_string();
            Ok((
                Message::assistant().with_text(output),
                ProviderUsage::new("fake".into(), Usage::new(Some(100), Some(60), Some(160))),
            ))
        }
    }

    #[tokio::test]
    async fn complete_prose_summary_is_kept_instead_of_aborting() {
        let model = ProseModel {
            calls: AtomicUsize::new(0),
        };
        let messages = vec![Message::user().with_text("x".repeat(9_000))];
        let result = summarize_in_chunks(
            &model,
            &FakeEstimator,
            &Templates::default(),
            &messages,
            8_000,
            8192,
        )
        .await
        .expect("a complete non-JSON summary must not abort the compaction");
        assert!(!result.structured);
        assert!(result.message.as_concat_text().contains("popover clamp"));
    }

    /// A model whose multi-message batches are cut off at the output limit, exactly
    /// where a big batch stops mid-JSON.
    struct TruncatingModel {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl CompactionModel for TruncatingModel {
        async fn complete(
            &self,
            system: &str,
            _: &[Message],
        ) -> Result<(Message, ProviderUsage), ProviderError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let sentinels = ('A'..='L')
                .filter(|letter| system.contains(&format!("sentinel-{letter}")))
                .count();
            if sentinels > 1 {
                let output = r#"```json
{"user_intent": ["revisar el batch", "la tarea pendiente es"#
                    .to_string();
                return Ok((
                    Message::assistant().with_text(output),
                    ProviderUsage::new("fake".into(), Usage::new(Some(100), Some(8192), Some(8292)))
                        .with_finish_reasons(vec!["length".to_string()]),
                ));
            }
            let output = serde_json::json!({
                "user_intent": ["un mensaje"],
                "pending_tasks": ["seguir"]
            })
            .to_string();
            Ok((
                Message::assistant().with_text(output),
                ProviderUsage::new("fake".into(), Usage::new(Some(50), Some(20), Some(70))),
            ))
        }
    }

    #[tokio::test]
    async fn truncated_batch_is_split_instead_of_aborting() {
        let model = TruncatingModel {
            calls: AtomicUsize::new(0),
        };
        let messages = ('A'..='D')
            .map(|letter| {
                Message::user().with_text(format!("sentinel-{letter} {}", "x".repeat(400)))
            })
            .collect::<Vec<_>>();
        let minimum = input_tokens(
            &FakeEstimator,
            &Templates::default(),
            &[format_message_for_compacting(&messages[0])],
        )
        .await
        .unwrap();

        let result = summarize_in_chunks(
            &model,
            &FakeEstimator,
            &Templates::default(),
            &messages,
            minimum + 110,
            8192,
        )
        .await
        .expect("a truncated batch must be split instead of aborting the compaction");

        assert!(
            model.calls.load(Ordering::Relaxed) > 1,
            "the truncated batch must have been split"
        );
        assert!(result.message.as_concat_text().contains("un mensaje"));
    }
}
