## Goal
You are compacting a working conversation so the same agent can resume it accurately. Preserve the current task and its constraints, not a transcript of everything said. The most recent user correction or change of scope takes precedence over earlier plans.

## Selection and fidelity
- First capture the active request, explicit prohibitions, decisions already made, what has actually been completed, and the exact next action if the user has authorized it.
- Preserve essential paths, commands, identifiers, parameters, error messages, test results and environment details needed to continue. Include exact text only when a mismatch would affect the next step; summarize long logs and repeated tool output.
- Separate verified observations from untested assumptions, proposals, and pending checks. A passing mock or replay is not proof of a live system. Do not turn planned or delegated work into completed work.
- Record failures that still matter and their fixes; omit detours whose outcome is fully superseded. Do not invent missing information or infer that a tool action succeeded merely because it was requested.
- Capture durable user preferences only when they affect this task. Do not copy secrets, access tokens, passwords, or full credentials into the summary; describe where they are stored instead.
- Keep the summary concise enough to resume efficiently. Spend space on continuation-critical details, not every message, path or code block. If the history is extensive, retain more necessary detail rather than imposing a rigid length cap.

**Conversation history:**
{{ messages }}

Review the history privately, then output exactly one fenced ```json block and no other text. Keep the keys and types below; omit a field when no information belongs in it:

```json
{
  "user_intent": ["current user goal and operative constraints; include earlier goals only if still active"],
  "pending_tasks": ["unfinished tasks with status and acceptance criteria, most urgent first"],
  "current_work": "where work stopped, what is running or awaiting a result, and what was last verified",
  "next_step": "only an action that directly continues a user instruction; otherwise omit",
  "problem_solving": ["decisions, tradeoffs, verified outcomes, and important rejected approaches"],
  "errors_and_fixes": ["unresolved failures or fixes necessary to avoid repeating a failure"],
  "files": [
    {
      "path": "precise path of a relevant file",
      "summary": "observed or performed change and its verification status",
      "key_code": "only a small essential snippet or exact signature, if necessary"
    }
  ],
  "technical_concepts": ["only tools, methods and environment details needed to continue"],
  "user_messages": ["exact latest correction or constraint only when its wording matters"]
}
```

Rules: all list entries are strings except `files`, whose entries are objects with the keys shown. Order lists by importance. Do not include placeholder entries, unsupported claims, scratch analysis, or text outside the JSON fence.
