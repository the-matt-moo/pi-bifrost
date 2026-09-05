# Changelog

All notable changes to pi-bifrost are documented here.

## Unreleased

### Fixed
- Fixed `/bifrost debug`, `doctor`, `init`, `refresh`, `providers`, and `probe` outputs getting truncated with `... (widget truncated)` in the TUI when exceeding 10 lines. They now display in a scrollable full-screen overlay modal (`uiResult`), while preserving non-interactive behavior.

### Changed
- Config is now global-only: `~/.pi/agent/bifrost.json` is the single source
  of truth (highest precedence) and the only config file read besides the
  extension default. Per-project layers (`bifrost.json`, `.pi/bifrost.json`)
  are no longer loaded, so routing is identical in every cwd.
- `/bifrost init`, `refresh`, `update`, `add-model`, and `remove-model` now
  write `~/.pi/agent/bifrost.json` instead of `<cwd>/.pi/bifrost.json`.
- Runtime artifacts (state, classification cache, probe results, reliability,
  and debug log) moved from `<cwd>/.pi/` to `~/.pi/agent/`, so they are
  shared across sessions and no longer depend on cwd.

### Removed
- `/bifrost sync` command. It shelled out to `sync-bifrost.ps1` in the
  `pi-profile` repo, which was deleted upstream (pi-profile v1.3.9 removed
  bifrost sync in favor of local per-machine maintenance).

## 4.5.18 - 04-09-2026

### Fixed
- Status consumers such as Pi Atelier now receive the category actually selected by routing instead of a context-window heuristic that mislabeled large-context models as `frontier`.

## 4.5.17 - 01-09-2026

### Fixed
- A fully-drained (0%) rolling session now blocks selection for every tier, including `quick`. Previously `quick` was fully exempt from session filtering, so a provider at 0% session remaining was still picked and returned a guaranteed 429.

## 4.5.16 - 01-09-2026

### Added
- `keys.toggle` shortcut (e.g. `"toggle": "ctrl+p"`) toggles pin/unpin of the current model in one key. Unpinning also clears thinking pin and resumes `apply` mode.

### Changed
- Pinned models that return a retryable provider error (429 / rate limit) are now auto-unpinned immediately so the next prompt routes to a healthy model. Previously the pin was retained and the user had to manually unpin.

## 4.5.15 - 01-09-2026

### Added
- `quotaRouting.sessionReservePercent` (default 0.10) sets the rolling-session exhaustion threshold.
- Anthropic session (5-hour) telemetry is now tracked separately from the weekly window.

### Changed
- Routing now removes subscription models with less than 10% session allowance remaining (over 90% used) from selection for every tier except `quick`, avoiding a guaranteed 429 plus retries before the circuit opens.

## 4.5.14 - 01-09-2026

### Added
- Image prompts now prefer a vision-capable model and fall back to higher tiers when the selected tier cannot accept image input.

### Changed
- Routing now treats `model.input` as the capability source for image prompts.

## 4.5.13 - 31-08-2026

### Removed
- Stale compaction config, schema, docs, and tests left behind after removing pre-switch compaction.

## 4.5.12 - 30-08-2026

### Removed
- Context-preservation compaction logic (`compactBeforeSwitch`, `prepareContextSwitch`, context-switch.ts).
- Bifrost now relies on pi harness native compaction behavior for context management.

## 4.5.11 - 30-08-2026

### Changed
- Context-preservation compaction disabled by default (`compactBeforeSwitch: false`).
- Default threshold increased from 60% to 85% for users who enable the feature.
- Reduces aggressive mid-session compaction that invalidates context-mode FTS5 cache.

## 4.5.10 - 29-08-2026

### Added
- Context-safe switching now projects usage against the target model window and waits for compaction before normal, quota, and retry handoffs.
- `classifier.fallbackToRegex` now controls regex tier fallback after classifier failure or rejection.

### Changed
- Classifier prompts are capped at 8,000 characters and 8 output tokens; confidence is required when gating is enabled.
- Valid classifier rejections fall through immediately without another paid attempt or failure cooldown.
- Pinned-session prompts now refresh topic history, including short unrelated-topic detection.
- Model probes use a four-token response budget.

### Fixed
- Failed or unavailable compaction now retains the current model and reports why instead of racing the model switch.
- Config/schema defaults now match the shipped context-preservation and confidence settings.

## 4.5.9 - 29-08-2026

### Changed
- Automatic regex and fallback routes now auto-pin the main-session model to avoid context loss from mid-session provider handoffs.
- Pins now release for explicit inline overrides, clearly unrelated topics, or exhausted providers; subagent model routing remains independent.

## 4.5.8 - 29-08-2026

### Added
- Listed model additions and removals directly inside the `/bifrost refresh` and `/bifrost probe` TUI confirmation dialog prompt (`Write config update?`).

## 4.5.7 - 29-08-2026

### Added
- **Auto-pin on classified model switch**: when Bifrost classifies a prompt (via LLM classifier or regex rules) and routes to a different model, it automatically pins that model for the rest of the session. This prevents per-prompt model churn from fragmenting context (cache misses, thinking-level resets, and quota-tracking gaps between providers). Manual inline overrides (e.g. `frontier debug this`) still switch without pinning; `Ctrl+Delete` unpins at any time. Auto-pin is session-local and never persisted (ADR-0015).

## 4.5.6 - 29-08-2026

### Added
- Classifier confidence gating: `classifier.confidenceThreshold` rejects low-confidence LLM tier picks so routing falls through to regex/default instead of switching models unnecessarily.
- Pre-switch compaction: `compactBeforeSwitch` compacts conversation history before `pi.setModel()` when context usage crosses `compactBeforeSwitchThreshold`, reducing the tokens re-billed on a cache miss.

### Changed
- Classifier responses now carry an optional confidence score (`tier 0.0-1.0`); old prompts that only emit the tier name still work and default to full confidence.

## 4.5.5 - 29-08-2026

### Changed
- Free models now automatically use their highest supported thinking level in advisory/apply mode; manual thinking pins still take precedence.

## 4.5.4 - 28-08-2026

### Added
- Pinned models now automatically unpin before a prompt when fresh quota telemetry shows their provider is exhausted, then switch to a same-tier scoped model from another provider with measured quota available.

## 4.5.3 - 28-08-2026

### Fixed
- Stop tracking Graphify's machine-local scan-root state; it is now ignored so clones remain portable.

## 4.5.2 - 28-08-2026

### Added
- Subcommand `/bifrost add-model [<model-key>]` to probe a model first, then add it to settings.json `enabledModels`, mark it as a scoped model in `bifrost.json` discovery metadata, prompt the user to place it in one or more existing categories, reload the configuration, and refresh the model registry.
- Classifier config now supports ordered `fallbackModels`, so Bifrost can try several classifier candidates before dropping to regex or default routing.
- Subcommand `/bifrost remove-model <model-key>` to remove a model from settings.json `enabledModels`, all bifrost.json tier lists, and discovery metadata, with registry refresh.

## 4.4.3

### Fixed
- Models from providers with exhausted weekly quota are now preemptively skipped during routing regardless of strategy. Previously quota filtering only affected `subscription_balance` and `subscription_preferred` strategies; models from drained providers could still be selected by `first`, `cheapest`, or `fastest` strategies.
- Broadened `isRetryableProviderLimit` regex to catch more error formats (`limit reached`, `limit exceeded`, `quota_exceeded`, `rate_limit`, `insufficient credits/balance/quota`) across both human-readable and JSON error messages so auto-retry fires reliably.

### Added
- `filterQuotaExhausted()` in routing — strips models from providers whose `weeklyRemainingFraction` is at or below `reservePercent`. Never removes all candidates (deadlock guard).
- Quota-exhausted models appear in `SkippedCandidate[]` with reason `"quota_exhausted"`.

## 4.4.2

## 4.4.1

### Removed
- Dead code: `session-fallback.ts`, `test-thinking.mjs`, `rule-learning.ts` (zero imports since v0.3.2).
- Deprecated `findCachedCategory()` from cache module and its tests — replaced by explicit `lookupCache` + `touchCacheEntry`.

## 4.4.0

### Added
- Classifier performance controls: `timeoutMs` (10 seconds), `maxAttempts` (2), and `cooldownSeconds` (60) bound failure latency and temporarily skip unhealthy classifier models.
- Successful model probes are cached per model for one hour. `/bifrost probe`, `init`, `update`, and `refresh` accept `--force` to bypass cached probe results.

### Changed
- Prompt routing now refreshes Pi's model registry with stale-while-revalidate. Existing registry data routes immediately; empty or explicitly invalidated registries still wait for recovery.
- Classifier `auto` mode only uses the subprocess when direct transport is unavailable. Completed invalid direct responses are no longer resent, reducing failure-path tokens and latency.
- Classification cache lookups reuse an in-memory exact/token index. Cache writes are deferred and coalesced with a synchronous exit flush instead of blocking prompt routing.
- Routing reuses diagnosed candidates rather than scanning the model registry twice.
- Empty quota telemetry now respects refresh backoff instead of retrying on every prompt.

### Fixed
- Anthropic quota requests now use the same four-second timeout as other quota providers, preventing a stalled request from wedging future refreshes.

## 4.3.2

### Fixed
- Add `refresh` subcommand to dashboard options list shown on empty `/bifrost` command.

## 4.3.1

### Added
- **Auto-retry on rate limits**: when a provider returns a 429 / `ResourceExhausted` / rate-limit error and the failed turn produced no assistant output or tool results (replay-safe), Bifrost automatically switches to the next healthy model in the same tier and resubmits the original prompt via `pi.sendUserMessage({ deliverAs: "followUp" })`. No user action required.
- `reliability.autoRetry` config flag (default `true`) and `reliability.maxAutoRetries` (default `2`) to tune or disable the behaviour.
- `isRetryableProviderLimit()` helper in `reliability.ts` matches 429, `ResourceExhausted`, `rate-limit`, `quota exceeded/reached/exhausted`, `usage limit`, and `request limit reached` patterns.
- `RuntimeRetryContext` on `RuntimeReliabilityTracker`: tracks the original prompt, attached images, tier, and auto-retry count across Pi's internal retry chain so the settled handler can replay the request.
- `noteToolResults()` on `RuntimeReliabilityTracker`: records whether any tool calls completed during the turn; used together with assistant-output detection to determine replay safety.
- `config.ts` validation: `maxAutoRetries` must be an integer >= 0.

## 4.3.0

### Added
- `/bifrost refresh`: adds newly scoped models and removes models no longer in Pi's scoped selection, without recategorizing existing tiers. Aliases the update path (`init`-equivalent discovery, probe, and reconcile) but preserves every currently-categorized model.
- `/bifrost refresh` invokes the config reload action after any add/remove, keeping live routing in sync with the written config.

### Changed
- `/bifrost update` and `/bifrost refresh` share one reconcile implementation (`handleDiscoveryReconcile`); refresh simply forces scoped-mode discovery.

## 4.2.3

### Fixed
- Candidate resolution now scopes to Pi's enabled-model selection (`scopedModels`) instead of the full registry. Classifier model lookup and tier inference both filter through a new `scopedCandidates` helper, preventing Bifrost from selecting models the user has not enabled in Pi.

## 4.2.2

### Added
- `writing` tier: explanation and documentation tasks now route to a dedicated tier instead of `general`. Default rules send `explain this`, `write docs`, `summarize this`, and similar writing-heavy prompts to `writing`.
- `writing` added to `BifrostTier` type, `loadConfig` base `categoryStrategies`, and the shipped `bifrost.json` (strategy: `subscription_balance`).
- `writing` tier color: blue in the routing statusline.

### Fixed
- Tiers with empty model lists (`[]`) no longer throw `requested_tier_unavailable`. Bifrost now auto-derives candidates from the live registry via `guessTier` when a tier has no explicitly configured models. `writing` aliases to `general` for this lookup since `guessTier` has no writing class. Explicit `/bifrost discover` still recommended for stable, reproducible routing.

## 4.2.1

### Fixed
- Model registry refresh no longer leaks performance marks when `ctx.modelRegistry.refresh()` throws.
- `debugMeasure` end-function now gracefully handles missing performance marks instead of propagating a `SyntaxError`, preventing the error from surfacing to users during subagent spawning.

## 4.2.0

### Added
- `keys` config binds optional pin and unpin shortcuts. Both are unbound by default.

### Changed
- **Breaking:** `Ctrl+Delete` is no longer hardcoded for unpin. Pi's extension API accepts literal keys only, so bindings now live in machine-local `bifrost.json` instead of the published package. Add `"keys": { "unpin": "ctrl+delete" }` to restore the previous behaviour.

### Fixed
- Model switches no longer pin thinking when Pi delivers their concurrent `thinking_level_select` event after `model_select`.

## 4.1.9

### Fixed
- Switching models (`Ctrl+P` / model picker) no longer pins the thinking level. Pi re-clamps the thinking level during a model switch and emits `thinking_level_select` *before* `model_select`, which Bifrost read as a manual pin. Bifrost now compares `ctx.model` against the model the last thinking change was seen under: a different model means the change is a model-switch side effect, not a user pin. Only a thinking change under the same model (`Shift+Tab` / `Ctrl+Tab` cycle) pins thinking; `Ctrl+Delete` still unpins both.

## 4.1.8

### Fixed
- `thinking_level_select` now calls `syncBifrostModeStatus`, so `thinkingPinned` is written to `statusline.json` when the thinking level is pinned. Previously only `model_select` synced the file, so the statusline showed `think:pinned` only when the *model* was pinned and kept `think:<mode>` for thinking-only pins.

## 4.1.7

### Fixed
- `thinking_level_select` no longer logs a false "Thinking level manually changed to <level>; Bifrost thinking pinned." when Bifrost applies its own configured-default thinking level. The `selfSettingThinkingLevel` guard was cleared synchronously, before the async event reached the handler; the guard now survives until the handler consumes it (and is cleared at the next `input` as a safety net).

## 4.1.6

### Changed
- Statusline shows `think:pinned` in orange when thinking level is manually pinned (was `think:<mode>` in magenta regardless of pin state).
- `Ctrl+Delete` now unpins both model and thinking in one keystroke (was toggle model pin only).

## 4.1.5

### Added
- README: routing suffix reference documenting all classification sources, suffix patterns, and possible values.

## 4.1.4

### Changed
- Routing announcement line now shows `pinned` (hot pink) in the category slot when Bifrost is pinned: `Bifrost: pinned → <model>`. Emitted on each prompt while pinned (routing is otherwise bypassed).

## 4.1.3

### Changed
- Statusline routing line restyled: the `→` arrow is now white and the model provider/name (e.g. `openrouter/tencent/hy3`) is now violet; the `Bifrost` word keeps its rainbow gradient and the tier keeps its color.
- Routing log lines (`already active`, `classified`, `fallback`) now render through `formatBifrostRouting`, so the same coloring applies to the TUI routing messages.

## 4.1.2

### Fixed
- Security: classifier subprocess now inherits a minimal env (`PATH`/`HOME`/`USERPROFILE`/`TEMP`/`TMPDIR`) instead of the full `process.env`, avoiding secret leakage into child processes.
- Classification pipeline correctness: classifier result continues to take priority over regex tier matches (preserves the `classifier beats regex` guarantee).

### Changed
- Optimization: removed the expensive fallback that spawned a full `pi` session when the registry classifier returned an empty response — now returns `undefined` and lets the pipeline fall through to regex/default.
- Optimization: reduced classifier subprocess timeout from 120s to 30s for faster failure recovery.
- Refactor: `regexClassify` is now computed once per classification and reused across pipeline stages (was called up to 3×). Removed the dead no-classifier else-branch.
- Refactor: cached the resolved cache file path in `index.ts` instead of recomputing `cachePath(process.cwd(), …)` at four call sites.
- Classification source label `complexity` added to `ClassificationSource` for accurate debug attribution (was mislabeled `regex`).

## 4.1.1

### Fixed
- Escaped `/bifrost thinking` usage-table arguments so Markdown renders the complete command.
- Documented `subscription_preferred` and corrected subscription routing details: Anthropic participates alongside Codex and Antigravity; the quota-balance threshold is 10 percentage points.

## 4.1.0

### Added
- **New `subscription_preferred` routing strategy**: Prioritizes subscription-linked models (Anthropic, Antigravity, OpenAI Codex) over paid-credit OpenRouter models, then free models, then unknown providers. Subscription models are balanced using quota weights to keep weekly allowances within 10% of each other.

### Changed
- **Updated `subscription_balance` strategy**: Increased weekly quota balance tolerance from 2% to 10%. When two or more subscription providers' remaining allowances are within 10%, the strategy uses normal list order; otherwise it prefers the provider with more remaining allowance.
- **`billingClass`**: Anthropic was already included as a subscription provider (added in 4.0.9); it now participates in both `subscription_balance` and `subscription_preferred` quota balancing.

### Notes
- `subscription_preferred` priority: subscription > free > unknown > paid-credit (OpenRouter).
- Both strategies require the `quotaRouting` config block and fresh quota telemetry.

## 4.0.12
- Removed forced `temperature: 0` from model probing so provider sampling defaults apply.

## 4.0.11
- Removed image-generation model routing (`image-quick` and `image-complex` tiers) to revert 4.0.7 and 4.0.8 features.

## 4.0.9
- Added `anthropic` to the `subscription` billing class so its usage is tracked and balanced alongside `openai-codex` and `antigravity`.
- `QuotaCoordinator` now fetches Anthropic's OAuth telemetry (`/api/oauth/usage`) using the `pi-anthropic-auth` extension's credentials. This allows the `subscription_balance` strategy to accurately steer traffic away from Anthropic when nearing quota limits.

## 4.0.7
- Added `Ctrl+Delete` shortcut to toggle Bifrost model pinning for current session.

## 4.0.5
- Added the chosen thinking level and concise model/thinking rationale to `/bifrost preview <prompt>`.

## 4.0.2
- Fixed `/bifrost thinking <mode>` parsing so the full routed subcommand no longer fails validation.
- Added `thinkingMode` to persistent and immediate Bifrost status output as `think:advisory` or `think:apply`.
- Added the thinking command to the dashboard and prints its accepted arguments when prefilled.

## 4.0.1
- Fixed startup on Pi runtimes that reject action methods during extension loading. Active thinking level is now read from `session_start`, after runtime initialization.
- Added a regression test that fails if the extension factory calls runtime action methods instead of only registering behavior.

## 4.0.0
- **Added opt-in prompt-derived thinking-level selection**: Bifrost can now intelligently recommend or apply a thinking budget based on prompt complexity, diagnostic intent, session turn depth, and correction markers.
  - **Zero latency, zero tokens**: Driven by a specialized <20µs scoring heuristic rather than an LLM call.
  - **Advisory by default**: Logs the recommendation without modifying Pi's active level unless you configure `"mode": "apply"`.
  - **Sticky task floor**: Upgrades thinking level immediately when needed, but safely prevents mid-task thrashing by requiring a topic change before de-escalating.
  - **Manual pinning**: Explicitly changing the thinking level via Pi (e.g. `/thinking max`) pins the feature and cedes control back to the user.
  - **Granular limits**: Configurable `defaultLevel`, `maxLevel`, and `byTier` boundaries.
- Added `/bifrost thinking [off|advisory|apply|status]` command to control and inspect this dynamically.

## 0.3.3
- **Fixed scoped-models filtering on `init --scoped` and `update --scoped`**: when user explicitly requests `--scoped`, all configured scoped-models are now included regardless of discovery errors or probing failures. Auth and connectivity issues are left for the user to handle downstream instead of silently excluding models.

## 0.3.2
- **Immediate runtime-error failover**: any final provider error now opens that model's circuit immediately, including non-HTTP exhaustion errors such as `ResourceExhausted: Worker local total request limit reached`. The next prompt selects the next healthy model from the same category before falling back to the default category.
- Probe-only transient errors still use the configured failure threshold; automatic prompt replay remains disabled to prevent duplicate tool calls or other side effects.
- Removed a stale `rule-learning.ts` import so typechecking passes cleanly.

## 0.3.1
- **Fixed probe false-negatives on thinking-only models**: Antigravity Gemini models (and other reasoning-capable models) that return thinking-only output with no final text are now correctly treated as reachable. Previously these were marked as errors via a misleading minimal-session fallback that lost custom provider/OAuth registration. `PROBE_MAX_TOKENS` increased from 5 to 16 to reduce thinking truncation.
- **Probe signature simplified**: `runProbe()` no longer accepts a session-fallback callback; all call sites updated.
- **Tests updated**: Added "treats thinking-only stream response as ok" and "returns error when stream stopReason is error" tests.

## 0.3.0
- **Session-aware routing**: classification pipeline tracks recent tier history. When 2+ of the last 3 prompts used the same tier, ambiguous follow-ups inherit that tier instead of falling to default. Resets on topic change (Jaccard similarity < 0.3), idle timeout (10 min), or inline override.
- **Prompt complexity heuristic**: pre-classifier stage short-circuits to "quick" for trivially short prompts (<30 tokens, no code blocks, no frontier keywords) and escalates to "frontier" for complex prompts (200+ tokens, 3+ file references, or multi-paragraph with code). Reduces LLM classifier calls by 15-25%.
- **Tier descriptions in classifier prompt**: LLM classifier now receives auto-generated descriptions of what each tier handles (extracted from regex rules at build time), improving classification accuracy for ambiguous prompts.
- **Expanded general-tier regex rules**: 6 new rules cover refactoring, implementation, explanation, documentation, error handling, and API integration — previously only test-writing matched the general tier.
- **Implicit feedback loop**: cache entries track demotion signals from manual model overrides. After 3 demotions, an entry's tier auto-escalates (quick→general, general→frontier).
- **Parallel classification**: LLM classifier and regex rules now execute concurrently instead of sequentially, reducing routing latency by 200-500ms on cache-miss prompts.
- **Cache warm-start**: on first use, cache is pre-seeded with representative phrases from regex rules, eliminating cold-start LLM classifier calls for common patterns.
- **Rule learning module**: new `suggestRules()` analyzes cache entries to identify recurring prompt bigrams and proposes new regex rules, reducing future classifier dependency.

## 0.2.0
- Improved model discovery and model categorization logic.

## 0.1.14
- Structured diagnostics with corrective actions for all error paths. Unresolvable model patterns, classifier failures, and setModel errors now show what went wrong and how to fix it instead of dumping raw stderr.
- Startup validation warns about model patterns that don't resolve in the registry.
- Per-prompt warnings (debounced) when a tier has unresolved patterns.
- `/bifrost doctor` command: on-demand config health check validating all model patterns and classifier model against the live registry.
- `setModel` error messages now show the actual cause (auth missing, network error, etc.) instead of the generic "no API key" message.

## 0.1.13
- `/bifrost init` now shows a detailed summary before the write prompt: models grouped by tier, classifier selection, discovery skips, and probe errors. The confirm dialog includes model/tier counts and error totals instead of a generic "Write config?" message.

## 0.1.12
- Instant circuit-open on HTTP 400+ errors. Any 4xx/5xx response (rate limits, auth failures, server errors) immediately opens the circuit breaker for that model — no need to hit the 3-failure threshold. Next prompt automatically routes to a different model.
- Improved failure logging: HTTP status codes are surfaced in the warning message with a hint that the circuit has opened.

## 0.1.11
- `--free` discovery now fetches the OpenRouter free-models collection page at runtime and sorts quick-tier free models by popularity ranking (cumulative token throughput). Non-free quick-tier models sort by context window capacity. Falls back to probe-speed sort if collection page is unreachable.
- Status synchronization fix for Bifrost mode changes.
- Weekly quota tolerance routing for subscription-balanced model selection.

## 0.1.0
- Silent mode configuration (`"silent": true`) to turn off all Pi console outputs and UI notifications while model routing remains active.
- `/bifrost silence` and `/bifrost unsilence` slash subcommands.
- Persisted `silent` state in `.pi/bifrost-state.json`.
- `subscription_balance` routing strategy: weighs Codex/Antigravity candidates by weekly subscription allowance remaining and keeps paid OpenRouter-compatible candidates blocked until measured subscriptions reach the configured reserve.
- `quotaRouting` config (`reservePercent`, `gamma`, `staleMinutes`, `refreshMinutes`, optional provider overrides).
- Local, credential-safe quota telemetry for Codex and Antigravity; only normalized fractions/reset times enter routing state.
- Independent `/bifrost init --scoped`, `--free`, and combined discovery modes.
- `/bifrost update --scoped|--free` reconciliation with source ownership metadata, deduplication, and safe removal of discovery-managed entries only.
- Deterministic discovery and subscription-steering tests.
- Subscription-balanced frontier example and explicit original-project attribution.