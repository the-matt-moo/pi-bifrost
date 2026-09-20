# Pi-Bifrost

![Pi-Bifrost social card](docs/social-card.png)

Native model routing for [Pi](https://pi.dev). Before generation starts, Bifrost switches Pi's active model based on prompt complexity, routing rules, or LLM classification.

```text
"summarize this file"                  → quick model
"implement the login endpoint"         → coding model
"design the auth system architecture"  → frontier model
```

## Disclaimer

This repository exists for **learning and personal use**. It is shared publicly for posterity and community benefit. There are **no guarantees or warranties**, express or implied, regarding fitness for any particular purpose, reliability, or correctness. **Caveat emptor** — use at your own risk.

This is not an official product. It may break, drift from upstream, or stop working without notice.

## Attribution

Pi-Bifrost is a fork and continuation of [Pi-Bifrost](https://github.com/iamaamir/pi-bifrost), originally created by [Aamir (`@iamaamir`)](https://github.com/iamaamir). Core architecture, routing foundation, reliability/circuit-breaker design, command interface, tests, documentation, and project identity remain credited to that project and author.

See [NOTICE.md](NOTICE.md) and [CHANGELOG.md](CHANGELOG.md) for full attribution and change history.

## What This Fork Adds

| Area | Original | This fork |
|------|----------|-----------|
| Model selection strategy | `first`, `cheapest`, `random`, `largest_context` | Adds `subscription_balance` (10% tolerance) and `subscription_preferred` (subscription > free > unknown > paid-credit); opted-in categories balance weekly allowances within 10% of each other |
| Credit spend policy | All candidates equally eligible | Both `subscription_balance` and `subscription_preferred` partition candidates by billing class: subscription models with usable weekly quota are always tried first via weighted random; paid-credit (OpenRouter) models are only reached when every subscription candidate is drained below `reservePercent` or absent |
| Model discovery | Probes all Pi models | Adds `--scoped` (Pi enabled-models only, always included when requested regardless of discovery errors) and `--free` (top 5 OpenRouter free models by collection ranking, or top 5 fastest if ranking fetch fails) flags for `init` and `update`; `update --free` enforces the same cap |
| Candidate scoping | Full registry | Classifier model lookup and tier inference filter candidates to Pi's scoped-model selection when active, gracefully falling back to all registry models in unscoped and subagent sessions |
| Image prompts | Routed like text-only prompts | Prefers vision-capable models; if the selected tier cannot take images, Bifrost falls back to higher tiers with image support |
| Pin quota safety | Manual pin remains until explicitly removed | A pinned model that returns a 429 or rate-limit error is auto-unpinned immediately so the next prompt routes to a healthy model; quota-exhausted models are also unpinned proactively before the request; classified switches auto-pin to prevent context-loss churn |
| Reliability | Threshold-based circuit breaker | Any final runtime provider error immediately opens that model's circuit (including `ResourceExhausted`, `MALFORMED_FUNCTION_CALL`, 502/503/504, and overload errors); parses explicit wait times into exact cooldowns, tracks account-level limits across providers, and auto-retries across alternative tier providers |
| Stale-registry warnings | Warning shown on stale host registry | A strict-tier "no healthy model" warning is re-checked after a single registry refresh before being shown; the warning appears only when the tier is genuinely unavailable due to circuits or quota exhaustion |
| Config reconciliation | `init` only | Adds `/bifrost update --scoped/--free` to preview and merge discovery results while preserving manual entries |
| Silent mode | Not available | `/bifrost silence` / `unsilence` suppresses console and UI output without disabling routing |
| Error diagnostics | Raw stderr dumps | Structured error messages with corrective actions; `/bifrost doctor` validates config against live registry |
| Classification pipeline | 4-stage waterfall (cache→LLM→regex→default) | 7-stage adaptive pipeline: regex pre-check → cache → session momentum → complexity heuristic → parallel LLM+regex → default |
| Classifier accuracy | Tier names only in LLM prompt | Auto-generated tier descriptions from regex rules injected into classifier prompt |
| Multi-turn routing | Each prompt classified independently | Session momentum: 2+ same-tier classifications carry forward; topic-change detection resets momentum |
| Routing latency | Sequential: cache miss → LLM → regex | Stale-while-revalidate registry updates, bounded classifier attempts, failure cooldowns, indexed cache lookup, and complexity short-circuits keep prompt routing off slow maintenance paths |
| Classifier confidence | Tier-only LLM output | `classifier.confidenceThreshold` requires an explicit score and rejects missing/low-confidence picks so routing falls through to regex/default without retrying another classifier |
| Classifier auth | Manual provider auth resolution | Classifier and probe streams run through `ctx.modelRegistry.streamSimple()`, so provider credentials resolve through the host registry (OAuth, env, stored keys) instead of a bespoke auth lookup |
| Self-correction | Static cache, no feedback | Demotion tracking on manual overrides; cache entries auto-escalate tier after 3 demotions |
| Cold start | Empty cache → every prompt hits LLM | Cache warm-start seeds entries from regex rules on first use |
| Category taxonomy | `quick`/`general`/`frontier` | Adds a dedicated `coding` category (implementation, debugging, refactoring, tests, code review, codebase investigation, typing/error handling, API integration); `general` is now a non-specialized catch-all with no development regex rules of its own |
| Category strictness | All categories fall back to `default` when unhealthy/unavailable | `strictCategories` (default `["coding"]`) exposes the unavailable/unhealthy result instead of silently switching to an unapproved cross-category model; eligibility comes only from explicit `models.coding` patterns, never `guessTier`/cost/context discovery |
| Routing intent conflicts | Stale cache/session tier and complexity heuristics could override a same-turn regex match | A configured-category regex match in the current turn beats a conflicting stale cache/session tier and skips the complexity shortcut entirely |
| Subscription guard | Not available | Redirects OpenRouter model IDs by prefix (e.g. `{"openai/": "openai-codex"}`) to subscription providers when available and within quota |

### Subagent Integration

Bifrost exposes an in-process `bifrost:rpc:v1` classification channel for subagent bridges. The `classifyTask` method returns the selected model and thinking level without changing the active Pi session model. This supports Claude Code-style subagent extensions such as `@tintinweb/pi-subagents` and `@gotgenes/pi-subagents`. Child subagent sessions are automatically detected and silenced so background/headless routing logs do not emit raw `stderr` into the terminal or corrupt the parent's fullscreen prompt window.

### How the Improved Routing Pipeline Works

The original Bifrost pipeline was a 4-stage waterfall: try the cache, then ask an LLM classifier, then fall back to regex rules, then use the default tier. Each prompt was classified independently with no memory of recent context, no awareness of prompt complexity, and no feedback from routing outcomes.

The improved pipeline addresses each of these gaps:

1. **Session momentum** prevents tier thrashing in multi-turn conversations. If you're debugging across several prompts, ambiguous follow-ups like "yes, try that" stay on the frontier tier instead of dropping to general.

2. **Complexity heuristics** skip the LLM classifier entirely for clear-cut cases — a 3-word formatting request goes straight to quick tier, a 500-line multi-file paste goes straight to frontier. This reduces classifier calls by 15-25%.

3. **Tier descriptions** tell the classifier LLM what each tier actually handles (auto-generated from your regex rules), instead of just sending bare tier names. This improves accuracy for ambiguous prompts.

4. **Bounded classification** limits classifier attempts to a shared wall-clock budget and classifier input to 8,000 characters. Failed transports enter a short cooldown; valid rejections immediately fall through without another classifier call. `confidenceThreshold` rejects missing or weak scores, and `auto` mode does not resend completed direct responses through a subprocess.

5. **Self-correction** tracks when you manually override a routing decision. After 3 such signals on the same prompt pattern, the cache entry's tier auto-escalates.

6. **Image capability fallback** checks image attachments after routing; if the chosen model cannot accept images, Bifrost walks higher tiers until it finds one that can.

7. **Warm start and indexed lookup** pre-seed common patterns and keep exact/fuzzy cache lookup allocation low. Cache writes are deferred and coalesced so disk I/O does not block prompt routing.

## Statusline

When Bifrost is the active statusline source, the routing line reads:

```text
Bifrost: <tier> → <model> (<source>; N skipped)
```

- `Bifrost` renders in a rainbow gradient.
- `<tier>` is colored by tier: quick (green), general (cyan), writing (blue), coding (magenta), frontier (orange).
- `→` is white.
- `<model>` (provider/name, e.g. `openrouter/tencent/hy3`) is violet.
- the trailing `(source; N skipped)` note is grey.
- when pinned, the category slot shows `pinned` in hot pink: `Bifrost: pinned → <model>`.
- when thinking is pinned, the mode status shows `think:pinned` in orange. This reflects a thinking-only pin and is independent of whether the model is pinned.
- `statusline.json` exposes the category actually selected by routing; dashboards such as Pi Atelier should not infer it from model cost or context size.

### Routing Suffix

The parenthetical suffix after the model shows how the tier was determined:

```typescript
type ClassificationSource = "cache" | "classifier" | "regex" | "complexity" | "inline"
```

**Suffix patterns:**

1. **Model already active** (no switch):
   ```
   (already active, <source>[, <reason>])
   ```
   - `source`: one of the 5 classification sources above.
   - `reason`: optional fallback reason if the requested tier fell back.

2. **Model switched** (classified):
   ```
   (<source>[; <detail>])
   ```
   - `source`: one of the 5 classification sources above.
   - `detail`: optional, may include:
     - `selected tier <name>` — actual tier differs from classified tier.
     - `<N> skipped` — N models were unreachable/unavailable.
     - a fallback reason (e.g. quota exhausted).

3. **Model switched** (fallback):
   ```
   (fallback[; <detail>])
   ```
   - Used when no classification succeeded and the default tier is used.
   - `detail`: same options as pattern 2.

**All possible values:**

| Value | Meaning |
|-------|--------|
| `cache` | Matched a cached prompt/tier pair |
| `classifier` | LLM classifier determined the tier |
| `regex` | Regex routing rule matched |
| `complexity` | Complexity heuristic (quick win for obvious requests) |
| `inline` | Manual override via `/bifrost <tier> <prompt>` |
| `already active` | Model unchanged (already Pi’s active model) |
| `fallback` | No classification succeeded; using fallback tier |
| `N skipped` | N models unavailable due to circuit break/quota/error |
| `selected tier <name>` | Routing chose a different tier than classification suggested (quota/reliability) |

## Install

> **Requires Pi >= 0.86.0** (uses the 0.86-era normalized-context API).

From npm (scoped):

```bash
pi install npm:@tenchi4u/pi-bifrost
```

From source:

```bash
pi install git:github.com/the-matt-moo/pi-bifrost
```

For local development, configure Pi to load your cloned package directory in your machine-local `settings.json`. Do not commit machine-specific package paths.

## Setup

Run once after install:

```
/bifrost init
```

This probes every model you have access to, finds which ones respond, and writes a config. Successful probe results are reused for one hour; pass `--force` to retest immediately. Bifrost routes prompts from that point forward. If a selected model ends with a provider error, Bifrost opens its circuit immediately; replay-safe rate-limit, overload, and transient 502/503/504 failures can automatically retry on the next healthy model.

If `/bifrost init` has not been run, Bifrost auto-derives tier candidates at runtime from the live registry using `guessTier`. This works but skips probe-based ordering and quota preferences. Run `/bifrost init` for stable, reproducible routing.

Narrow discovery scope when needed:

```text
/bifrost init --scoped          # Pi scoped-models selection only
/bifrost init --free            # OpenRouter free tier only
/bifrost init --scoped --free   # union of both
/bifrost refresh               # add new scoped models, remove stale ones (keeps tiers, auto-reloads)
```

## Usage

| Command | What it does |
|---------|-------------|
| `/bifrost` | Dashboard with mode, model, and quick actions |
| `/bifrost init [--force]` | Probe models and generate config; fresh successful probes are reused for one hour unless forced |
| `/bifrost on` / `off` | Enable or disable routing |
| `/bifrost pin` / `unpin` | Lock the main-session model; automatic routes (including regex and fallback) auto-pin, while manual overrides, clearly unrelated topics, or unavailable models can switch it (subagents remain independent; see `keys` config for shortcuts) |
| `/bifrost silence` / `unsilence` | Suppress or restore console output |
| `/bifrost preview <prompt>` | See model routing, thinking level, and concise reasons without sending |
| `/bifrost reload` | Reload config after manual edits |
| `/bifrost refresh [--free] [--force]` | Reconcile scoped models without recategorizing tiers; force bypasses fresh probe results |
| `/bifrost probe [--scoped] [--free] [--force]` | Check model availability; reuse fresh successes unless forced |
| `/bifrost doctor` | Validate config against available models |
| `/bifrost classifier on` / `off` | Toggle LLM classifier |
| `/bifrost add-model [<model-key>]` | Probe the model first, then add it to settings.json enabledModels, mark it as scoped in config, prompt for category placement, and refresh registry |
| `/bifrost remove-model <model-key>` | Remove model from settings.json enabledModels, all bifrost.json tiers, and discovery metadata; refresh registry |
| `/bifrost thinking [off\|advisory\|apply\|status]` | Inspect or set prompt-derived thinking mode |

Active advisory/apply mode appears immediately in Bifrost status as `think:advisory` or `think:apply`.

Force a tier for one message by prefixing it:

```
frontier debug this race condition
quick summarize this
```

## Architecture & Routing Strategy

Bifrost automates model selection via a robust heuristic pipeline during initialization and dynamic evaluation at runtime.

### 1. Initialization: Categorization & Ordering
When you run `/bifrost init`, models are probed, fetched, and categorized automatically:
- **Text Models (`guessTier`)**: Models are categorized by explicit overrides, parameter counts, architecture patterns, cost, and context:
  - `modelTiers` in `tierHeuristics` explicitly pins a model to a tier.
  - Parameter size: $\le 14\text{B}$ → `quick`, $\ge 70\text{B}$ → `frontier`.
  - Architecture patterns: lightweight indicators (`haiku`, `flash`, `mini`, `nano`, `lite`) → `quick`; frontier indicators (`opus`, `sonnet`, `pro`, `max`, `r1`, `o1/o3`) → `frontier`.
  - Cost: > $5/1M tokens → `frontier`, < $1/1M tokens → `quick`, everything else → `general`.
  - *Subscription models* (Anthropic, Codex, Antigravity) use context-window heuristics instead of cost: ≥200k tokens = `frontier`, ≥64k = `general`, otherwise `quick`.
  - All thresholds and patterns are configurable under `tierHeuristics` in `bifrost.json`.
  - `writing` is a routing-only tier (explain/docs/summarize tasks). It has no `guessTier` cost class; when unconfigured it uses `general`-tier candidates at runtime.
  - `coding` is also routing-only — `guessTier` never assigns it. `/bifrost init` never auto-populates `coding`; add `models.coding` patterns yourself with models you've approved for implementation/debugging/review work. `coding` is strict by default (`strictCategories`): if its candidates are missing or unhealthy, routing surfaces that instead of silently falling back to `general`/`default`.
- **Intra-Tier Ordering (`sortTierModels`)**: Non-free models are sorted ascending by their **probe latency** (fastest first). Free models are sorted by their **OpenRouter collection rank**.

### 2. Runtime Model Selection Strategies
Once models are categorized, the configured `strategy` determines which model is chosen from the selected tier:
- `first` / `fastest` — picks the top model in the list (which `/bifrost init` naturally orders by lowest latency).
- `cheapest` / `cheapest_input` / `cheapest_output` — strictly optimizes for token cost.
- `largest_context` — favors models with the largest token window for massive context tasks.
- `random` — randomly picks a candidate to load-balance or vary responses.
- `subscription_preferred` / `subscription_balance` — both partition candidates by billing class. Subscription models (Anthropic, Codex, Antigravity) with usable weekly quota are tried first via weighted random (gamma-curved by remaining allowance). When providers differ by more than 10 percentage points, the higher-allowance provider is favored; within 10 points, weighted selection balances across all viable subscription models. Paid-credit (OpenRouter) models are only reached when every subscription candidate is drained below `reservePercent` or absent. Free and unknown models serve as intermediate fallback.

### 3. Dynamic Pipeline: Prompt Routing
For every prompt, Bifrost executes a staged evaluation:
1. **Inline Overrides**: E.g., `frontier debug this`.
2. **Direct-model Regex Rules**: Explicit provider/model rules bypass tier classification.
3. **Cache & Session Momentum**: Indexed fuzzy matching reuses successful classifications; related follow-ups retain the dominant recent tier.
4. **Complexity Heuristic**: Obvious short requests route to `quick`; large or multi-file requests route to `frontier` without an LLM call.
5. **Bounded LLM Classifier**: Tries the classifier model and its ordered fallbacks within a 10-second total budget by default. Failed models cool down for 60 seconds.
6. **Tier Regex Rules**: The already-computed regex result is used when classification does not return a valid tier.
7. **Default Tier**: If all else fails, Bifrost uses the configured default.

A regex rule that matches a configured category in the current turn takes priority over a conflicting cached/session-momentum tier from an earlier turn, and skips the complexity heuristic entirely — so a short `coding`-rule match doesn't drop to `quick`, and a long one doesn't escalate to `frontier`, just because those signals would otherwise apply.

Registry refreshes use stale-while-revalidate: existing models route the current prompt immediately while refresh runs in the background. An empty registry or explicit recovery still waits for fresh data. Quota telemetry also backs off after empty results and degrades to neutral routing.

### 4. Model Autopinning
To prevent context-loss from per-prompt model churn, Bifrost **auto-pins** the selected model whenever it routes to a different model via the LLM classifier or regex rules (classification source). This keeps thinking-level state, cache continuity, and quota tracking stable across a multi-model session. Manual inline overrides (e.g. `frontier debug this`) switch without pinning — only classified switches lock in. `Ctrl+Delete` unpins at any time. Autopinning is session-local and never persisted.

### 5. Thinking Mode Steering
If `"thinking": { "mode": "apply" }` is set in config, Bifrost assesses prompt complexity to dynamically steer the selected model's **thinking level/effort**.
- Ambiguous logic puzzles, architectural queries, or math proofs elevate the thinking budget.
- Simple formatting or translation requests lower the thinking budget.
- Free models always use their highest supported thinking level; manual thinking pins still take precedence.
- `advisory` mode logs what Bifrost *would* do without modifying Pi's active state.
- When *you* manually change the thinking level, Bifrost logs `Thinking level manually changed to <level>; Bifrost thinking pinned.` and pins for the session. Bifrost's own automatic applies are silent — that line means a manual change, not a Bifrost default.
- Only a thinking change under the *same* model pins thinking. Switching models re-clamps the thinking level as a side effect; that never pins. `Ctrl+P` toggles the pin; `Ctrl+Delete` unpins model and thinking.

## Config

Config merges from two paths (agent dir wins):

1. Extension default (`<extensionDir>/bifrost.json`)
2. Global (`~/.pi/agent/bifrost.json`)

There is no per-project config layer: routing is global, so behavior is
identical in every cwd. `/bifrost init`, `refresh`, `update`, `add-model`, and
`remove-model` all write to `~/.pi/agent/bifrost.json`. Shared runtime
artifacts (cache, probe results, reliability, debug log) live under
`~/.pi/agent/`, while session toggles (enabled/classifier/thinking/silent)
are stored per Pi session.

Minimal config after `init`:

```json
{
  "enabled": true,
  "default": "general",
  "strategy": "first",
  "models": {
    "quick": ["opencode/deepseek-v4-flash-free"],
    "general": ["opencode-go/deepseek-v4-pro"],
    "frontier": ["openai-codex/gpt-5.6-sol"]
  }
}
```

Shortcuts are machine-local and unbound by default — Pi's extension API takes literal keys, not remappable action ids, so keyboard layouts stay a per-machine concern:

```json
{ "keys": { "unpin": "ctrl+delete", "toggle": "ctrl+p" } }
```

Manual model selection already pins Bifrost, so a separate `pin` key is usually unnecessary. `toggle` combines pin and unpin into one key. Pick keys the host does not reserve (`shift+tab`, `ctrl+c/d/l/o/t`, and the model-cycle keys are reserved). Reserved keys are skipped with a startup diagnostic.

Classifier latency controls are optional and backward-compatible. Jev uses its native Choice API, with direct TypeSafe first and OpenRouter as the transport fallback:

```json
{
  "classifier": {
    "model": "typesafe/jev-latest",
    "fallbackModels": ["openrouter/~typesafe/jev-latest"],
    "jevCredentialTarget": "pi-bifrost/jev-api-key",
    "method": "direct",
    "timeoutMs": 10000,
    "maxAttempts": 2,
    "cooldownSeconds": 60,
    "confidenceThreshold": 0.4,
    "fallbackToRegex": true,
    "categoryDescriptions": {
      "coding": "implementation, debugging, refactoring, tests, code review"
    }
  }
}
```

Store the TypeSafe API key as a **Generic Credential** in Windows Credential Manager under `pi-bifrost/jev-api-key` (or the configured target). Bifrost reads it through `CredRead`; it is not stored in JSON or logged. The OpenRouter fallback reuses Pi's existing `openrouter` provider credential.

`classifier.categoryDescriptions` overrides the built-in per-category description sent to the classifier. Jev receives those descriptions as native Choice criteria; text classifiers receive them in the prompt. Known categories (`quick`, `general`, `writing`, `coding`, `frontier`) already have built-in descriptions; custom categories fall back to descriptions generated from their regex rules.

`strictCategories` (default `["coding"]` once `coding` is configured) marks categories whose model resolution must not silently fall back to another category:

```json
{ "strictCategories": ["coding"] }
```

Redirect OpenRouter models to subscription providers to avoid paying credit fees for models covered by an active subscription:

```json
{
  "subscriptionGuard": {
    "openai/": "openai-codex"
  }
}
```

If the target subscription provider is exhausted (session or weekly quota), the redirect is skipped and OpenRouter selection stands.

`fallbackToRegex: false` skips tier regex fallback after classifier failure or rejection; direct model-reference rules still short-circuit before classification.

Prompt-derived thinking is disabled by default. Set `"thinking": { "mode": "advisory" }` to log recommendations without changing Pi's level, or use `"mode": "apply"` to opt into automatic level changes. Manual thinking-level changes pin the feature for the session. See the [full config reference](docs/) and [examples/](examples/) for advanced options including routing rules, classifier setup, reliability tuning, and quota-aware routing.

## Testing

```bash
npm test                       # unit tests
npm run test:integration       # integration tests
npm run test:ui                # Pi TUI smoke tests
npm run test:ui:reliability    # reliability E2E with fake provider
```

## Related

[Bifrost Patterns](https://github.com/iamaamir/bifrost-pattern) — prompt workflows built on top of Bifrost routing (scouts, reviewers, model comparisons). Optional, not required.

## License

MIT. See [NOTICE.md](NOTICE.md) for attribution details.
