"""Patch the aegis fork with the ACP rewind surface (idempotent-guarded).

Each patch asserts its exact occurrence count so a mismatch fails loudly instead
of half-applying. CRLF sources: patterns are written with LF and converted.
"""

import pathlib
import sys

ROOT = pathlib.Path(r"C:\aegis")
applied = 0


def patch(rel, before, after, count=1):
    global applied
    path = ROOT / rel
    data = path.read_text(encoding="utf-8", newline="")
    crlf = data.count("\r\n")
    lf = data.count("\n") - crlf
    nl = "\r\n" if crlf > lf else "\n"
    needle = before.replace("\n", nl)
    replacement = after.replace("\n", nl)
    found = data.count(needle)
    if found == 0 and data.count(replacement) >= 1:
        print(f"skip {rel}: already applied")
        return
    if found != count:
        print(f"FAIL {rel}: expected {count} match(es), found {found}")
        sys.exit(1)
    path.write_text(data.replace(needle, replacement), encoding="utf-8", newline="")
    applied += 1
    print(f"ok   {rel}: {found} replacement(s)")


# 1. Expose the shared rewind module through the conversation re-exports.
patch(
    r"crates\aegis\src\lib.rs",
    """pub mod conversation {
    pub use aegis_providers::conversation::*;
}
""",
    """pub mod conversation {
    pub use aegis_providers::conversation::*;
    pub mod rewind;
}
""",
)

# 2. Register the ACP server submodule.
patch(
    r"crates\aegis\src\acp\server.rs",
    """mod resources;
mod schedule;
""",
    """mod resources;
mod rewind;
mod schedule;
""",
)

# 3. Dispatch the new custom method.
patch(
    r"crates\aegis\src\acp\server\custom_dispatch.rs",
    """    #[custom_method(TruncateSessionConversationRequest)]
    async fn dispatch_truncate_session_conversation(
        &self,
        req: TruncateSessionConversationRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_truncate_session_conversation(req).await
    }
""",
    """    #[custom_method(TruncateSessionConversationRequest)]
    async fn dispatch_truncate_session_conversation(
        &self,
        req: TruncateSessionConversationRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_truncate_session_conversation(req).await
    }

    #[custom_method(RewindSessionRequest)]
    async fn dispatch_rewind_session(
        &self,
        req: RewindSessionRequest,
    ) -> Result<RewindSessionResponse, agent_client_protocol::Error> {
        self.on_rewind_session(req).await
    }
""",
)

# 4. Report hidden rows to clients so they can mark the tail the model lost.
patch(
    r"crates\aegis\src\acp\server\message_meta.rs",
    """    #[serde(skip_serializing_if = "std::ops::Not::not")]
    steer: bool,
""",
    """    #[serde(skip_serializing_if = "std::ops::Not::not")]
    steer: bool,
    /// Only present when the message is hidden from the model (a compaction or a
    /// rewind), so clients can mark the tail the agent no longer sees.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    agent_visible: bool,
""",
)

patch(
    r"crates\aegis\src\acp\server\message_meta.rs",
    """        created: message.created,
        message_id: message.id.as_deref(),
        steer,
""",
    """        created: message.created,
        message_id: message.id.as_deref(),
        steer,
        agent_visible: message.is_agent_visible(),
""",
)

# 5. The request/response pair of the new custom method.
patch(
    r"crates\aegis-sdk-types\src\custom_requests.rs",
    """pub struct TruncateSessionConversationRequest {
    pub session_id: String,
    pub truncate_from: i64,
}
""",
    """pub struct TruncateSessionConversationRequest {
    pub session_id: String,
    pub truncate_from: i64,
}

/// Rewind a session to an earlier user turn.
///
/// Everything from that turn on stops being sent to the model; nothing is
/// deleted, so the client keeps the transcript. The turn's text comes back for
/// the client to prefill its composer and edit before resending.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_aegis/unstable/session/rewind",
    response = RewindSessionResponse
)]
#[serde(rename_all = "camelCase")]
pub struct RewindSessionRequest {
    pub session_id: String,
    /// Stored id of the user message to rewind to. Wins over `back`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// How many user turns to go back (1 = the last one) when `message_id`
    /// is absent. Defaults to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub back: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct RewindSessionResponse {
    /// How many stored messages stopped being sent to the model.
    pub hidden: u32,
    /// Id of the turn that was rewound to.
    pub message_id: String,
    /// One-line preview of that turn.
    pub preview: String,
    /// Full text of that turn, to prefill the client's composer.
    pub text: String,
    /// Rewindable turns the model can still see (0 = this was the first one).
    pub remaining_turns: u32,
}
""",
)

# 6. One implementation of the visibility flip, shared with the CLI.
patch(
    r"crates\aegis-cli\src\session\mod.rs",
    """    /// Flip `agent_visible` off for every stored message from `from_index`
    /// on, and return how many the model stopped seeing.
    async fn hide_tail_from(
        &self,
        conversation: &Conversation,
        from_index: usize,
    ) -> Result<usize> {
        let mut hidden = 0usize;
        for message in conversation.messages().iter().skip(from_index) {
            if !message.is_agent_visible() {
                continue;
            }
            if let Some(message_id) = message.id.as_deref() {
                self.agent
                    .config
                    .session_manager
                    .update_message_metadata(&self.session_id, message_id, |mut metadata| {
                        metadata.agent_visible = false;
                        metadata
                    })
                    .await?;
            }
            hidden += 1;
        }
        Ok(hidden)
    }
""",
    """    /// Flip `agent_visible` off for every stored message from `from_index`
    /// on, and return how many the model stopped seeing. Shared with the ACP
    /// server, which rewinds through `_aegis/unstable/session/rewind`.
    async fn hide_tail_from(
        &self,
        conversation: &Conversation,
        from_index: usize,
    ) -> Result<usize> {
        aegis::conversation::rewind::hide_tail_from(
            &self.agent.config.session_manager,
            &self.session_id,
            conversation,
            from_index,
        )
        .await
    }
""",
)

print(f"applied {applied} patch(es)")
