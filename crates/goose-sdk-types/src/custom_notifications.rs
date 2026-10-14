use crate::custom_requests::CustomMethodSchema;
use agent_client_protocol::{JsonRpcMessage, JsonRpcNotification};
use schemars::{JsonSchema, SchemaGenerator};
use serde::{Deserialize, Serialize};

/// Goose-custom session update notification — a parallel to ACP's
/// `session/update` carrying goose-specific update variants.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcNotification)]
#[notification(method = "_goose/unstable/session/update")]
#[serde(rename_all = "camelCase")]
pub struct GooseSessionNotification {
    pub session_id: String,
    pub update: GooseSessionUpdate,
}

/// Discriminated union of goose-specific session update payloads.
/// Variant tag matches ACP's convention (`sessionUpdate: "<snake_case>"`).
///
/// `discriminator.mapping` is what makes TS codegen (`@hey-api/openapi-ts`)
/// emit the correct snake_case tag value even when this enum has a single
/// variant. Add a mapping entry per variant.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
#[schemars(extend("discriminator" = {
    "propertyName": "sessionUpdate",
    "mapping": {
        "usage_update": "#/$defs/SessionUsageUpdate",
        "status_message": "#/$defs/StatusMessageUpdate",
        "message_usage": "#/$defs/MessageUsageUpdate",
        "live_voice_interaction_ended": "#/$defs/LiveVoiceInteractionEndedUpdate"
    }
}))]
pub enum GooseSessionUpdate {
    UsageUpdate(SessionUsageUpdate),
    StatusMessage(StatusMessageUpdate),
    MessageUsage(MessageUsageUpdate),
    LiveVoiceInteractionEnded(LiveVoiceInteractionEndedUpdate),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LiveVoiceInteractionEndedUpdate {
    pub interaction_id: String,
    pub outcome: LiveVoiceInteractionOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LiveVoiceInteractionOutcome {
    Stopped,
    Failed,
}

/// Dedicated provider notification for OAuth device-code flow.
/// Sent during provider authentication when the ACP client supports
/// `goose.customNotifications` — avoids a fake empty session ID.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcNotification)]
#[notification(method = "_goose/unstable/providers/authentication/device-code")]
#[serde(rename_all = "camelCase")]
pub struct ProviderDeviceCodeNotification {
    pub provider_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}

impl Default for GooseSessionUpdate {
    fn default() -> Self {
        GooseSessionUpdate::UsageUpdate(SessionUsageUpdate::default())
    }
}

/// Streaming context-window usage update for a session.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageUpdate {
    pub used: u64,
    pub context_limit: u64,
    pub accumulated_input_tokens: u64,
    pub accumulated_output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accumulated_cost: Option<f64>,
    /// Desglose estimado de que compone el contexto enviado (calibrado al total real `used`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_breakdown: Vec<ContextPart>,
    /// Effective auto-compaction trigger, in tokens: context_limit scaled by
    /// auto_compact_threshold(context_limit), i.e. the lower of
    /// GOOSE_AUTO_COMPACT_THRESHOLD and GOOSE_AUTO_COMPACT_TOKEN_LIMIT / context_limit.
    /// Clients show this instead of assuming the default 80 percent.
    #[serde(default)]
    pub auto_compact_at: u64,
    /// The same trigger as a fraction of context_limit (0..1).
    #[serde(default)]
    pub auto_compact_pct: f64,
    /// Internal summarization calls (tool-pair compaction): billed, but they produce no
    /// assistant message, so a per-model breakdown cannot see them.
    #[serde(default)]
    pub compaction_calls: u64,
    #[serde(default)]
    pub compaction_input_tokens: u64,
    #[serde(default)]
    pub compaction_output_tokens: u64,
    /// Tokens per provider+model actually used in this session, from each assistant
    /// message's inference metadata. A session can switch models mid-flight, so the
    /// session-level model is not a valid attribution of its cost.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_usage: Vec<SessionModelUsage>,
}

/// One row of SessionUsageUpdate::model_usage.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelUsage {
    pub provider: String,
    pub model: String,
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// One row of `SessionUsageUpdate::context_breakdown`: an estimated slice of
/// the context that gets sent to the model, expressed in tokens.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextPart {
    /// Short ASCII Spanish label (no accents) so clients can render it as-is.
    pub label: String,
    /// Estimated tokens, calibrated so the rows add up to the real `used` total.
    pub tokens: u64,
    /// Number of messages/items folded into this row.
    pub count: u64,
    /// Optional short annotation; only set where it is cheap to compute.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Per-message token usage/cost/timing, keyed by the message id used for
/// chunk matching. Sent live after a turn's messages and on replay.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsageUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub usage: MessageUsageData,
}

/// Wire mirror of the conversation `MessageUsage` (this crate cannot depend on
/// goose-provider-types); field names and serde casing MUST stay in parity.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsageData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_source: Option<CostSourceData>,
    /// Wall-clock generation time, used by the client for a tokens/sec readout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_to_first_token_ms: Option<u64>,
    /// Usage from a compaction/summarization call rather than a normal turn.
    #[serde(default)]
    pub is_compaction: bool,
}

/// Wire mirror of the conversation `CostSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CostSourceData {
    /// Cost returned directly by the provider (e.g. OpenRouter `usage.cost`).
    ProviderReported,
    /// Cost computed from the canonical pricing table.
    Estimated,
}

/// Live UI/session status. This is not conversation transcript content, and
/// should not be persisted or replayed as history.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusMessageUpdate {
    pub status: StatusMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StatusMessage {
    #[serde(rename_all = "camelCase")]
    Notice { message: String },
    #[serde(rename_all = "camelCase")]
    Progress { message: String },
}

fn notification_schema<T>(generator: &mut SchemaGenerator) -> CustomMethodSchema
where
    T: Default + JsonRpcMessage + JsonSchema,
{
    let dummy = T::default();
    let type_name = std::any::type_name::<T>()
        .rsplit("::")
        .next()
        .unwrap_or(std::any::type_name::<T>())
        .to_string();
    CustomMethodSchema {
        method: dummy.method().to_string(),
        params_schema: Some(generator.subschema_for::<T>()),
        params_type_name: Some(type_name),
        response_schema: None,
        response_type_name: None,
    }
}

/// Schemas for every goose-custom outbound notification. To register a new
/// notification, define the struct above (with `JsonRpcNotification` +
/// `Default`) and add one line below.
pub fn custom_notification_schemas(generator: &mut SchemaGenerator) -> Vec<CustomMethodSchema> {
    vec![
        notification_schema::<GooseSessionNotification>(generator),
        notification_schema::<ProviderDeviceCodeNotification>(generator),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_message_serializes_to_expected_wire_shape() {
        let notification = GooseSessionNotification {
            session_id: "s1".to_string(),
            update: GooseSessionUpdate::StatusMessage(StatusMessageUpdate {
                status: StatusMessage::Notice {
                    message: "Compaction complete".to_string(),
                },
            }),
        };

        let value = serde_json::to_value(notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "status_message",
                    "status": {
                        "type": "notice",
                        "message": "Compaction complete"
                    }
                }
            })
        );
    }

    #[test]
    fn live_voice_interaction_ended_serializes_to_expected_wire_shape() {
        let notification = GooseSessionNotification {
            session_id: "s1".to_string(),
            update: GooseSessionUpdate::LiveVoiceInteractionEnded(
                LiveVoiceInteractionEndedUpdate {
                    interaction_id: "live_opaque".to_string(),
                    outcome: LiveVoiceInteractionOutcome::Failed,
                },
            ),
        };

        let value = serde_json::to_value(notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "live_voice_interaction_ended",
                    "interactionId": "live_opaque",
                    "outcome": "failed"
                }
            })
        );
    }

    #[test]
    fn message_usage_serializes_to_expected_wire_shape() {
        let notification = GooseSessionNotification {
            session_id: "s1".to_string(),
            update: GooseSessionUpdate::MessageUsage(MessageUsageUpdate {
                message_id: Some("m1".to_string()),
                usage: MessageUsageData {
                    input_tokens: Some(1200),
                    output_tokens: Some(340),
                    total_tokens: Some(1540),
                    cache_read_tokens: Some(1000),
                    cache_write_tokens: None,
                    cost: Some(0.0123),
                    cost_source: Some(CostSourceData::Estimated),
                    elapsed_ms: Some(4200),
                    time_to_first_token_ms: Some(840),
                    is_compaction: false,
                },
            }),
        };

        let value = serde_json::to_value(notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "message_usage",
                    "messageId": "m1",
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 340,
                        "totalTokens": 1540,
                        "cacheReadTokens": 1000,
                        "cost": 0.0123,
                        "costSource": "estimated",
                        "elapsedMs": 4200,
                        "timeToFirstTokenMs": 840,
                        "isCompaction": false
                    }
                }
            })
        );
    }
}
