# Pi-Bifrost

![Pi-Bifrost social card](docs/social-card.png)

Native model routing for [Pi](https://pi.dev). Before generation starts, Bifrost switches Pi's active model based on prompt complexity, routing rules, or LLM classification.

```text
"summarize this file"         → quick model
"debug this race condition"   → frontier model
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
| Credit spend policy | All candidates equally eligible | Subscription providers (Codex, Antigravity, Anthropic) preferred; `subscription_balance` blocks paid OpenRouter until subscriptions drain past `reservePercent`; `subscription_preferred` prioritizes subscription models entirely, falling back to free/unknown/paid-credit only when no subscription models are available |
| Model discovery | Probes all Pi models | Adds `--scoped` (Pi enabled-models only, always included when requested regardless of discovery errors) and `--free` (top 5 OpenRouter free models by collection ranking, or top 5 fastest if ranking fetch fails) flags for `init` and `update`; `update --free` enforces the same cap |
| Candidate scoping | Full registry | Classifier model lookup and tier inference filter candidates to Pi's scoped-model selection, preventing routing to models the user has not enabled |
| Reliability | Threshold-based circuit breaker | Any final runtime provider error immediately opens that model's circuit (including `ResourceExhausted`); next prompt selects the next healthy model in the same category, then falls back to the default category if needed |
| Config reconciliation | `init` only | Adds `/bifrost update --scoped/--free` to preview and merge discovery results while preserving manual entries |
| Silent mode | Not available | `/bifrost silence` / `unsilence` suppresses console and UI output without disabling routing |
| Error diagnostics | Raw stderr dumps | Structured error messages with corrective actions; `/bifrost doctor` validates config against live registry |
| Classification pipeline | 4-stage waterfall (cache→LLM→regex→default) | 7-stage adaptive pipeline: regex pre-check → cache → session momentum → complexity heuristic → parallel LLM+regex → default |
| Classifier accuracy | Tier names only in LLM prompt | Auto-generated tier descriptions from regex rules injected into classifier prompt |
| Multi-turn routing | Each prompt classified independently | Session momentum: 2+ same-tier classifications carry forward; topic-change detection resets momentum |
| Routing latency | Sequential: cache miss → LLM → regex | Parallel: LLM classifier and regex execute concurrently; complexity heuristic skips LLM for obvious cases |
| Self-correction | Static cache, no feedback | Demotion tracking on manual overrides; cache entries auto-escalate tier after 3 demotions |
| Cold start | Empty cache → every prompt hits LLM | Cache warm-start seeds entries from regex rules on first use |

### How the Improved Routing Pipeline Works

The original Bifrost pipeline was a 4-stage waterfall: try the cache, then ask an LLM classifier, then fall back to regex rules, then use the default tier. Each prompt was classified independently with no memory of recent context, no awareness of prompt complexity, and no feedback from routing outcomes.

The improved pipeline addresses each of these gaps:

1. **Session momentum** prevents tier thrashing in multi-turn conversations. If you're debugging across several prompts, ambiguous follow-ups like "yes, try that" stay on the frontier tier instead of dropping to general.

2. **Complexity heuristics** skip the LLM classifier entirely for clear-cut cases — a 3-word formatting request goes straight to quick tier, a 500-line multi-file paste goes straight to frontier. This reduces classifier calls by 15-25%.

3. **Tier descriptions** tell the classifier LLM what each tier actually handles (auto-generated from your regex rules), instead of just sending bare tier names. This improves accuracy for ambiguous prompts.

4. **Parallel execution** runs the LLM classifier and regex rules concurrently instead of sequentially, saving 200-500ms per cache-miss prompt.

5. **Self-correction** tracks when you manually override a routing decision. After 3 such signals on the same prompt pattern, the cache entry's tier auto-escalates.

6. **Warm start** pre-seeds the cache from your regex rules on first use, so common patterns route instantly without waiting for the LLM classifier.

## Statusline

When Bifrost is the active statusline source, the routing line reads:

```text
Bifrost: <tier> → <model> (<source>; N skipped)
```

- `Bifrost` renders in a rainbow gradient.
- `<tier>` is colored by tier: quick (green), general (cyan), writing (blue), frontier (orange).
- `→` is white.
- `<model>` (provider/name, e.g. `openrouter/tencent/hy3`) is violet.
- the trailing `(source; N skipped)` note is grey.
- when pinned, the category slot shows `pinned` in hot pink: `Bifrost: pinned → <model>`.
- when thinking is pinned, the mode status shows `think:pinned` in orange. This reflects a thinking-only pin and is independent of whether the model is pinned.

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

From npm (scoped):

```bash
pi install npm:@tenchi4u/pi-bifrost
```

From source:

```bash
pi install git:github.com/the-matt-moo/pi-bifrost
```

## Setup

Run once after install:

```
/bifrost init
```

This probes every model you have access to, finds which ones respond, and writes a config. Bifrost routes prompts from that point forward. If a selected model ends with a provider error, Bifrost opens its circuit immediately so the next prompt uses the next healthy model in that category. It never automatically replays a failed prompt.

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
| `/bifrost init` | Probe models and generate config (shows tier breakdown, errors, and model list before writing) |
| `/bifrost on` / `off` | Enable or disable routing |
| `/bifrost pin` / `unpin` | Lock current model for this session (see `keys` config for shortcuts) |
| `/bifrost silence` / `unsilence` | Suppress or restore console output |
| `/bifrost preview <prompt>` | See model routing, thinking level, and concise reasons without sending |
| `/bifrost reload` | Reload config after manual edits |
| `/bifrost refresh` | Add newly scoped models and drop models no longer in scope, without recategorizing existing tiers (auto-reloads on change) |
| `/bifrost doctor` | Validate config against available models |
| `/bifrost classifier on` / `off` | Toggle LLM classifier |
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
- **Text Models (`guessTier`)**: Models are categorized by cost and billing class.
  - Cost > $5/1M tokens → `frontier`
  - Cost < $1/1M tokens → `quick`
  - Everything else → `general`
  - *Subscription models* (Anthropic, Codex, Antigravity) use context-window heuristics instead of cost: ≥200k tokens = `frontier`, ≥64k = `general`, otherwise `quick`.
  - `writing` is a routing-only tier (explain/docs/summarize tasks). It has no `guessTier` cost class; when unconfigured it uses `general`-tier candidates at runtime.
- **Intra-Tier Ordering (`sortTierModels`)**: Non-free models are sorted ascending by their **probe latency** (fastest first). Free models are sorted by their **OpenRouter collection rank**.

### 2. Runtime Model Selection Strategies
Once models are categorized, the configured `strategy` determines which model is chosen from the selected tier:
- `first` / `fastest` — picks the top model in the list (which `/bifrost init` naturally orders by lowest latency).
- `cheapest` / `cheapest_input` / `cheapest_output` — strictly optimizes for token cost.
- `largest_context` — favors models with the largest token window for massive context tasks.
- `random` — randomly picks a candidate to load-balance or vary responses.
- `subscription_preferred` — chooses subscription models first (Anthropic, Codex, Antigravity), quota-balances them with the same 10-point threshold, then falls back to free, unknown, and paid-credit models in that order.
- `subscription_balance` — evaluates weekly quota telemetry for subscription providers (Anthropic, Codex, Antigravity). When providers differ by more than 10 percentage points of weekly allowance remaining, it favors the provider with more remaining quota; within 10 points, it retains normal list order. It suppresses paid OpenRouter credits while measured subscription allowance remains above `reservePercent`.

### 3. Dynamic Pipeline: Prompt Routing
For every prompt, Bifrost executes a 7-stage evaluation:
1. **Inline Overrides**: E.g., `frontier debug this`.
2. **Complexity Heuristic**: Short-circuits the LLM classifier for obvious cases. Text exceeding size thresholds bypasses LLM straight to `frontier`. Short 3-word commands go to `quick`.
3. **Session Momentum**: 2+ consecutive classifications in the same tier carry forward to ambiguous follow-ups, preventing tier-thrashing during deep debugging. Topic-change detection resets this momentum.
4. **Cache & Warm Start**: Fuzzy matching reuses recent successful classifications. The cache is pre-seeded by regex rules.
5. **LLM Classifier**: Analyzes the prompt against auto-generated tier descriptions built from your rules.
6. **Regex Rules (`DEFAULT_RULES`)**: Concurrently evaluated against the prompt (e.g., `\b(unit tests?|refactor)\b` → `general`, `\b(race condition|deadlock|security audit)\b` → `frontier`).
7. **Default Tier**: If all else fails, falls back to the configured default.

### 4. Thinking Mode Steering
If `"thinking": { "mode": "apply" }` is set in config, Bifrost assesses prompt complexity to dynamically steer the selected model's **thinking level/effort**.
- Ambiguous logic puzzles, architectural queries, or math proofs elevate the thinking budget.
- Simple formatting or translation requests lower the thinking budget.
- `advisory` mode logs what Bifrost *would* do without modifying Pi's active state.
- When *you* manually change the thinking level, Bifrost logs `Thinking level manually changed to <level>; Bifrost thinking pinned.` and pins for the session. Bifrost's own automatic applies are silent — that line means a manual change, not a Bifrost default.
- Only a thinking change under the *same* model pins thinking. Switching models (`Ctrl+P`) re-clamps the thinking level as a side effect; that never pins. `Ctrl+Delete` unpins model and thinking.

## Config

Config merges from multiple paths (later wins):

1. Extension default (`<extensionDir>/bifrost.json`)
2. Global (`~/.pi/agent/bifrost.json`)
3. Project root (`bifrost.json`)
4. Project config (`.pi/bifrost.json`)

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
{ "keys": { "unpin": "ctrl+delete" } }
```

Manual model selection already pins Bifrost, so a separate `pin` key is usually unnecessary. Pick keys the host does not reserve (`shift+tab`, `ctrl+c/d/l/o/t`, and the model-cycle keys are reserved). Reserved keys are skipped with a startup diagnostic.

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
