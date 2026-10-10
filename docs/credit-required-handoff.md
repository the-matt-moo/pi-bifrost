# Credit-required rejection and scoped handoff

Incident reviewed: 09-10-2026, Central Time (U.S.).

## Evidence and cause

Source: persisted Pi session JSONL assistant errors and model-change metadata reviewed by the incident-evidence agent, plus the installed Pi 1.1.0 retry implementation and the loaded external extension. No prompt, credential, or tool-argument dump is included here.

The recorded chain was Opus 4.6 → Opus 5.5 → Sonnet 5.5 → Fable 5.1 → Fable 5 → Codex. The preceding Opus/Sonnet errors were HTTP 429 `rate_limit_error`, without allowance-exhaustion or error-code details. They do **not** prove session utilization exceeded 95%.

Fable returned `credits_required` with `exhausted_included_allowance=false` and `disabled_reason=org_level_disabled`. This was a billing-gated model rejection, not confirmed included-allowance exhaustion. Fable was present in Pi's enabled model scope but absent from Bifrost's category lists.

The competing auto-discovered extension at `C:/Users/Tench/.pi/agent/extensions/auto-model-fallback.ts` handled `turn_end`, matched any 429, and selected same-provider models across the entire Pi scope without category restrictions. It could change models before Pi's automatic retries. Installed Pi 1.1.0 classifies that Fable error as retryable and defaults to three outer retries; observed delays near 2/4/8 seconds are consistent with that retry loop. Bifrost is not established as the source of the Fable selection.

At the user's request, the main agent disabled the competing extension by retaining a `.ts.disabled` backup. This does not unload code already running: restart or reload **idle** sessions. Do not reload during active work. Bifrost's previously missing handoff and scoped reliability protections were separate contributing gaps, not evidence that Bifrost caused this incident.

## Implemented behavior

- Fresh session usage strictly over 95% triggers configured/scoped same-category handoff, including quick, pinned/manual input, and subsequent requests in a multi-turn tool run. Exactly 95% is usable with the default 5% reserve; an explicitly higher reserve changes that boundary. Weekly and session windows remain separate.
- Native candidates precede OpenRouter regardless of configured ordering strategy. OpenRouter must also be configured and scoped in that category; ultra refuses it. No registry-based tier inference is used for handoffs.
- Images retain capable replacements. An empty pool, unresolved tool result, exhausted continuation budget, or failed switch stops instead of re-entering the exhausted model or another category.
- A deterministic bounded Markdown digest uses the current branch's model-visible projection, honoring context edits and compaction. It is held only in memory and injected once with `context`, never written to disk or debug logs. No model is invoked to summarize it.
- A finalized `agent_before_settle` boundary can request one continuation while preserving completed assistant/tool context. Only a fixed continuation instruction is persisted. Bifrost does not send the original prompt again or re-execute completed tools.

## Host boundary

Pi 1.1.0 offers no extension-level retry-cancel result for a provider error. `ctx.abort()` cancels the operation and suppresses automatic continuation, so it is appropriate for a safe stop, not a recovery handoff.

For exact `credits_required` only, Bifrost uses the documented `message_end` role-preserving replacement contract to prefix the error with `billing exhaustion (credits_required)`. The original provider error and content remain unchanged after that prefix. Pi's existing terminal billing classifier then prevents the outer three 429 retries before the finalized continuation boundary. Ordinary transient 429 messages are not rewritten.

Retries performed inside provider SDK/transport code before `message_end`, or later handlers from other extensions that override model/error state, are outside this guarantee. Keep one automatic fallback owner. Pinned or manual models with no explicit configured-category membership are tracked, but stop rather than infer a recovery category.

## Deterministic verification

Fake-registry event tests cover scope/category exclusions, native-first and OpenRouter ordering, ultra refusal, exactly-95% and over-95%, image capability, pinned tracking, safe stops, switch failures, continuation bounds, and one-shot digest injection.

Real Pi 1.1.0 SDK fake-provider gates use in-memory sessions and no discovered global extensions. They verify: a completed tool runs once; credit rejection receives zero outer retries and one continuation; session usage crossing 90% to 96% after a tool switches before the old model's next request; and no replacement aborts without another provider call. No paid model calls are required.
