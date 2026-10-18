# Graph Report - pi-bifrost  (2026-10-18)

## Corpus Check
- 108 files · ~162,006 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 6 file(s) not represented in the graph (top: (none) 4, .xml 1, .css 1)

## Summary
- 1468 nodes · 2782 edges · 127 communities (88 shown, 39 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 117 edges (avg confidence: 0.92)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b1b7928d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- config.ts
- classifier.ts
- reliability.ts
- Bifrost competitive architecture analysis
- package.json
- Bifrost UI enhancement backlog
- categoryStrategies
- routing.ts
- cache.ts
- bifrost.json
- advanced-classifier-prompt.json
- Pi-Bifrost
- ui-smoke.py
- index.ts
- models
- thinking.ts
- economical-frontier-reliability.json
- subscription-balance-frontier.json
- setupGatewayAnimation
- compilerOptions
- commands.ts
- economical-frontier.json
- quota.ts
- Changelog
- ui-reliability-fake-provider.sh
- ui-smoke-agent-tui.sh
- ux-status.ts
- Product
- RuntimeReliabilityTracker
- ReliabilityStore
- large-context.json
- Recipes
- bifrostExtension
- modelKey
- release.mjs
- routing.test.ts
- rules-only-local.json
- Pi-Bifrost Reliability System
- exact-bindings.json
- 1. `pi-model-router`: closest direct routing peer
- ref_node_assert
- fake-provider-server.mjs
- handoff.ts
- reliability-store.test.ts
- task-aware-routing.json
- OpenCode router landscape
- runtime-state.ts
- Reliability v1 implementation review
- classifier
- Mistakes, gotchas & learnings
- Design decisions & rationale
- Pi extension router landscape
- rpc.ts
- Not yet implemented
- Implemented: post-settlement failure tracking
- remote-prompt.test.ts
- pi-bifrost
- 2. `pi-router`: channel routing peer
- 3. `pi-failover`: strongest failover/replay warning
- 4. `pi-triage`: classification and discovery peer
- 5. `pi-model-switch`: user/agent control peer
- reliability
- 4.1.0
- 4.1.2
- 4.2.0
- 4.4.0
- 4.5.10 - 29-08-2026
- 4.5.21 - 05-09-2026
- Test infrastructure
- Findings
- What each does well
- Gaps worth considering
- Recommendations
- cache
- 4.10.1 - 19-09-2026
- 4.14.0 - 30-09-2026
- 4.15.2 - 05-10-2026
- 4.15.4 - 09-10-2026
- 4.15.5 - 15-10-2026
- 4.3.0
- 4.4.3
- 4.5.14 - 01-09-2026
- 4.5.15 - 01-09-2026
- 4.5.16 - 01-09-2026
- 4.5.6 - 29-08-2026
- 4.6.0 - 12-09-2026
- 4.7.0 - 13-09-2026
- How to add a feature
- 4.11.0 - 19-09-2026
- 4.11.4 - 20-09-2026
- 4.11.5 - 26-09-2026
- 4.13.0 - 27-09-2026
- 4.14.1 - 01-10-2026
- 4.14.2 - 03-10-2026
- 4.14.4 - 04-10-2026
- 4.14.5 - 04-10-2026
- 4.15.0 - 04-10-2026
- 4.15.1 - 04-10-2026
- 4.15.3 - 07-10-2026
- 4.16.0 - 15-10-2026
- 4.1.1
- 4.1.3
- 4.1.4
- 4.1.5
- 4.1.6
- 4.1.7
- 4.1.8
- 4.1.9
- 4.2.1
- 4.2.3
- 4.3.2
- 4.5.11 - 30-08-2026
- 4.5.12 - 30-08-2026
- 4.5.13 - 31-08-2026
- 4.5.17 - 01-09-2026
- 4.5.18 - 04-09-2026
- 4.5.22 - 05-09-2026
- 4.5.2 - 28-08-2026
- 4.5.3 - 28-08-2026
- 4.5.4 - 28-08-2026
- 4.5.5 - 29-08-2026
- 4.5.7 - 29-08-2026
- 4.5.8 - 29-08-2026
- 4.5.9 - 29-08-2026
- 4.9.0 - 15-09-2026
- 4.9.1 - 16-09-2026

## God Nodes (most connected - your core abstractions)
1. `bifrostExtension()` - 103 edges
2. `Changelog` - 86 edges
3. `createCommandRouter()` - 42 edges
4. `modelKey()` - 30 edges
5. `ReliabilityStore` - 24 edges
6. `debug()` - 22 edges
7. `handleDiscoveryReconcile()` - 21 edges
8. `@earendil-works/pi-coding-agent` - 21 edges
9. `recordModelFailure()` - 21 edges
10. `handleInit()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `P3 — runtime config validation should match schema integer constraints` --references--> `validateConfig()`  [INFERRED]
  docs/reliability-v1-review.md → config.ts
- `P1 — config and recovery` --references--> `validateConfig()`  [INFERRED]
  docs/ui-enhancements.md → config.ts
- `Provider-wide degradation (P3)` --references--> `resolveHealthyModel()`  [INFERRED]
  docs/reliability-spec.md → routing.ts
- `Strengths` --references--> `resolveHealthyModel()`  [INFERRED]
  docs/reliability-v1-review.md → routing.ts
- `Fallback context-window guard (P3)` --references--> `resolveModelWithFallback()`  [INFERRED]
  docs/reliability-spec.md → routing.ts

## Import Cycles
- None detected.

## Communities (127 total, 39 thin omitted)

### Community 0 - "config.ts"
Cohesion: 0.06
Nodes (42): CacheOptions, 4.11.3 - 20-09-2026, 4.2.2, Added, Changed, Fixed, Fixed, ALL_STRATEGIES (+34 more)

### Community 1 - "classifier.ts"
Cohesion: 0.06
Nodes (57): ClassificationResult, ClassifyOptions, CODING_TIER, createPipeline(), classify(), FRONTIER_DIRECTIVE, FRONTIER_EFFORT, FRONTIER_TIER (+49 more)

### Community 2 - "reliability.ts"
Cohesion: 0.15
Nodes (32): 2. Malformed-but-valid JSON crashes routing, Adding a new circuit state field, Adding a new failure source, Failure sources (what opens a circuit), Half-open circuit details, P1 — thrown `pi.setModel()` failures bypass circuit recording, P1 — valid-but-malformed persisted reliability JSON can crash routing, beginTrial() (+24 more)

### Community 3 - "Bifrost competitive architecture analysis"
Cohesion: 0.04
Nodes (49): 10. Risks and guardrails, 1. What Bifrost is, 2. Comparative scorecard, 3.1 Direct model routing, not prompt-guided routing, 3.2 Reliability design has correct safety bias, 3.3 Persisted circuit breaker is more mature than simple cooldown, 3.4 Minimal, model-agnostic default is a strategic advantage, 3.5 Core logic is already portable (+41 more)

### Community 4 - "package.json"
Cohesion: 0.05
Nodes (42): author, name, url, bugs, url, description, devDependencies, agent-tui (+34 more)

### Community 5 - "Bifrost UI enhancement backlog"
Cohesion: 0.06
Nodes (33): 1. Character-by-character input activates Pi autocomplete, 2. Screen stability is not a universal readiness condition, 3. Native terminal emulation does not isolate Pi, 4. agent-tui daemon state must be isolated, 5. Preserve visual coverage during migration, agent-tui PTY evaluation, Decision, Evidence (+25 more)

### Community 6 - "categoryStrategies"
Cohesion: 0.13
Nodes (15): categoryStrategies, architecture, code_review, debugging, free_pool, frontend, general, implementation (+7 more)

### Community 7 - "routing.ts"
Cohesion: 0.12
Nodes (27): 4.8.0 - 13-09-2026, Fixed, billingClass, classify(), extractParamCount(), filterSessionExhausted(), getModelQuota(), guessTier() (+19 more)

### Community 8 - "cache.ts"
Cohesion: 0.08
Nodes (32): CacheLookupIndex, cachePath(), createDeferredCacheWriter(), DEFAULT_MAX_ENTRIES, DEFAULT_THRESHOLD, DeferredCacheWriter, demoteCacheEntry(), evictIfNeeded() (+24 more)

### Community 9 - "bifrost.json"
Cohesion: 0.05
Nodes (37): cache, enabled, maxEntries, threshold, categoryStrategies, coding, frontier, general (+29 more)

### Community 10 - "advanced-classifier-prompt.json"
Cohesion: 0.06
Nodes (33): cache, enabled, maxEntries, threshold, categoryStrategies, frontier, general, quick (+25 more)

### Community 11 - "Pi-Bifrost"
Cohesion: 0.06
Nodes (28): Credit-required rejection and scoped handoff, Deterministic verification, Evidence and cause, Host boundary, Implemented behavior, Attribution, 1. Initialization: Categorization & Ordering, 2. Runtime Model Selection Strategies (+20 more)

### Community 12 - "ui-smoke.py"
Cohesion: 0.09
Nodes (10): capture(), Cell, load_font(), main(), reader(), Screen, send(), set_winsize() (+2 more)

### Community 13 - "index.ts"
Cohesion: 0.15
Nodes (18): isJevModelReference(), jevClassifierForReference(), generateTierDescriptions(), loadRules(), ADR-0015, getPipeline(), buildPipeline(), classifierModelPatterns() (+10 more)

### Community 14 - "models"
Cohesion: 0.13
Nodes (15): models, architecture, code_review, debugging, free_pool, frontend, general, implementation (+7 more)

### Community 15 - "thinking.ts"
Cohesion: 0.10
Nodes (16): assessThinking(), countQuestionMarks(), fileReferenceCount(), JEV_EFFORT_HIGH, JEV_EFFORT_MEDIUM, JEV_EFFORT_MINIMAL, JEV_EFFORT_XHIGH, jevEffortPoints() (+8 more)

### Community 16 - "economical-frontier-reliability.json"
Cohesion: 0.07
Nodes (27): cache, enabled, maxEntries, threshold, categoryStrategies, economical, frontier, classifier (+19 more)

### Community 17 - "subscription-balance-frontier.json"
Cohesion: 0.10
Nodes (19): categoryStrategies, frontier, general, quick, _comment, default, enabled, models (+11 more)

### Community 18 - "setupGatewayAnimation"
Cohesion: 0.14
Nodes (15): copyButtons, copyStatus, gatewayCanvas, reducedMotionQuery, setupGatewayAnimation(), createRoutes(), cubicPoint(), draw() (+7 more)

### Community 19 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, forceConsistentCasingInFileNames, module, moduleResolution, noEmit, noFallthroughCasesInSwitch, noUncheckedSideEffectImports (+8 more)

### Community 20 - "commands.ts"
Cohesion: 0.05
Nodes (91): CacheEntry, Fixed, ClassificationPipeline, capFreeModels(), CollectionRanking, fetchFreeModelRanking(), FREE_MODEL_LIMIT, openRouterSlug() (+83 more)

### Community 21 - "economical-frontier.json"
Cohesion: 0.09
Nodes (22): cache, enabled, maxEntries, threshold, categoryStrategies, economical, frontier, classifier (+14 more)

### Community 22 - "quota.ts"
Cohesion: 0.12
Nodes (19): Architecture map, autopilot, Bifrost today, model-fallback, model-router, fetchAnthropicQuota(), fetchAntigravityQuota(), fetchCodexQuota() (+11 more)

### Community 23 - "Changelog"
Cohesion: 0.07
Nodes (28): 0.1.0, 0.1.11, 0.1.12, 0.1.13, 0.1.14, 0.2.0, 0.3.0, 0.3.1 (+20 more)

### Community 24 - "ui-reliability-fake-provider.sh"
Cohesion: 0.20
Nodes (13): AGENT_TUI_SESSION_STORE, AGENT_TUI_SOCKET, AGENT_TUI_UI_STATE, AGENT_TUI_WS_DISABLED, AGENT_TUI_WS_STATE, model_attempts(), poll_until(), prompt() (+5 more)

### Community 25 - "ui-smoke-agent-tui.sh"
Cohesion: 0.24
Nodes (11): AGENT_TUI_SESSION_STORE, AGENT_TUI_SOCKET, AGENT_TUI_UI_STATE, AGENT_TUI_WS_DISABLED, AGENT_TUI_WS_STATE, resolve_binary(), send_command(), ui-smoke-agent-tui.sh script (+3 more)

### Community 26 - "ux-status.ts"
Cohesion: 0.25
Nodes (11): BifrostModeState, formatBifrostStatus(), modeLabel(), refreshRegistry(), REGISTRY_REFRESH_TTL_MS, RegistryRefreshState, setBifrostModeStatus(), setBifrostStatus() (+3 more)

### Community 27 - "Product"
Cohesion: 0.08
Nodes (23): Architecture, Change discipline, Git, Non-negotiable behavior, Pi-Bifrost agent guide, Product boundary, Read first, Verification (+15 more)

### Community 28 - "RuntimeReliabilityTracker"
Cohesion: 0.17
Nodes (9): 4.3.1, Added, 3. `agent_end` fires per retry, not per request, AssistantOutcome, modelKey(), RuntimeFailure, RuntimeReliabilityTracker, RuntimeRetryContext (+1 more)

### Community 29 - "ReliabilityStore"
Cohesion: 0.20
Nodes (5): ReliabilityConfig, ReliabilityState, ReliabilityIo, ReliabilityStore, ReliabilityStoreOptions

### Community 30 - "large-context.json"
Cohesion: 0.11
Nodes (18): categoryStrategies, deep, long-context, quick, classifier, enabled, fallbackToRegex, method (+10 more)

### Community 31 - "Recipes"
Cohesion: 0.12
Nodes (16): `advanced-classifier-prompt.json`, `economical-frontier.json`, `economical-frontier-reliability.json`, `exact-bindings.json`, Install Bifrost first:, `large-context.json`, Manual control, Pi-Bifrost examples (+8 more)

### Community 32 - "bifrostExtension"
Cohesion: 0.21
Nodes (13): autoPinSource(), frontierSystemPrompt(), bifrostExtension(), branch(), decideThinking(), hasImages(), state, switchForHandoff() (+5 more)

### Community 33 - "modelKey"
Cohesion: 0.24
Nodes (15): formatCandidateLines(), resolveTierDisplay(), isStrictCategory(), validateConfig(), Key files, selectHandoffModel(), inferPattern(), resolveImageCapableFallback() (+7 more)

### Community 34 - "release.mjs"
Cohesion: 0.33
Nodes (8): args, bumpVersion(), getLatestTag(), main(), parseVersion(), ROOT, run(), SCRIPT_DIR

### Community 35 - "routing.test.ts"
Cohesion: 0.26
Nodes (12): DEFAULT_RULES, @earendil-works/pi-ai, @earendil-works/pi-coding-agent, findCandidates(), findOneModel(), getStrategy(), resolveModel(), makeClassifierModel() (+4 more)

### Community 36 - "rules-only-local.json"
Cohesion: 0.17
Nodes (11): classifier, enabled, model, default, enabled, models, economical, frontier (+3 more)

### Community 37 - "Pi-Bifrost Reliability System"
Cohesion: 0.18
Nodes (9): Circuit states, Configuration reference, File map, How it works (end to end), Implemented: health-aware selection & circuit breaker, Overview, Persistence, Pi-Bifrost Reliability System (+1 more)

### Community 38 - "exact-bindings.json"
Cohesion: 0.22
Nodes (8): default, enabled, models, economical, frontier, rules, $schema, strategy

### Community 39 - "1. `pi-model-router`: closest direct routing peer"
Cohesion: 0.20
Nodes (10): 1. `pi-model-router`: closest direct routing peer, Architecture: virtual provider pattern, Bifrost lessons from deep source review, Comparison with Bifrost, Decision history, Key strengths for Bifrost to learn, Key weaknesses to avoid, Reliability model: absent (+2 more)

### Community 40 - "ref_node_assert"
Cohesion: 0.09
Nodes (20): jiti, isExecutable(), resolveTestBinary(), scriptPath, trimEnvValue(), unique(), agentDir, jiti (+12 more)

### Community 41 - "fake-provider-server.mjs"
Cohesion: 0.32
Nodes (6): attempts, json(), port, server, sse(), stats

### Community 42 - "handoff.ts"
Cohesion: 0.22
Nodes (9): BranchMessage, completedTools(), CONTINUATION, createHandoff(), isCreditsRequired(), text(), QuotaSnapshot, selectImageCapableModelFromGroups() (+1 more)

### Community 43 - "reliability-store.test.ts"
Cohesion: 0.24
Nodes (7): jiti, key(), model(), root, scenario(), cfg, makeIo()

### Community 44 - "task-aware-routing.json"
Cohesion: 0.22
Nodes (8): _comment, debug, enabled, default, enabled, rules, $schema, strategy

### Community 45 - "OpenCode router landscape"
Cohesion: 0.25
Nodes (5): Bifrost strengths to protect, Competitive positioning, OpenCode router landscape, Scope and sources, Suggested next research

### Community 46 - "runtime-state.ts"
Cohesion: 0.25
Nodes (10): applyRuntimeState(), loadSessionRuntimeState(), DEFAULT_RUNTIME_STATE, loadRuntimeState(), PersistedModeState, RuntimeModeState, runtimeStatePath(), saveRuntimeState() (+2 more)

### Community 47 - "Reliability v1 implementation review"
Cohesion: 0.25
Nodes (7): Follow-up test matrix, Merge recommendation, Reliability v1 implementation review, Strengths, Verdict, Verification run, What was reviewed

### Community 48 - "classifier"
Cohesion: 0.25
Nodes (8): classifier, enabled, fallbackToRegex, maxTokens, method, model, systemPrompt, temperature

### Community 49 - "Mistakes, gotchas & learnings"
Cohesion: 0.29
Nodes (7): 1. Pi's `pi.setModel()` throws, not returns false, 4. `PI_CODING_AGENT_DIR`, not `PI_AGENT_DIR` or `HOME`, 5. Fake server: HTTP 500 triggers retry, broken streams do not, 6. SSE `finish_reason: null` causes Pi to continue generating, 7. Half-open design evolved through three iterations, 8. Disabled reliability reported stale circuits, Mistakes, gotchas & learnings

### Community 50 - "Design decisions & rationale"
Cohesion: 0.29
Nodes (7): Design decisions & rationale, Why cooldown multiplier per-circuit, not global, Why disabled reliability still has behavioral knobs, Why JSON file, not SQLite or in-memory, Why model-keyed state, not provider-keyed, Why not retry same prompt on different model, Why trial flag is explicit, not inferred

### Community 51 - "Pi extension router landscape"
Cohesion: 0.29
Nodes (7): Cross-Pi comparison, Executive read, Next research questions, Pi extension router landscape, Pi-specific Bifrost advantages to protect, Pi-specific gaps to prioritize, Scope and sources

### Community 52 - "rpc.ts"
Cohesion: 0.33
Nodes (5): BIFROST_RPC_VERSION, ClassifyTaskResult, handleRpcRequest(), RpcReply, RpcRequest

### Community 53 - "Not yet implemented"
Cohesion: 0.33
Nodes (6): All-candidates-open policy improvements (P3), Degraded-recovery scoring (P3), Fallback context-window guard (P3), Multi-process state safety (P4), Not yet implemented, Provider-wide degradation (P3)

### Community 54 - "Implemented: post-settlement failure tracking"
Cohesion: 0.40
Nodes (4): Implemented: post-settlement failure tracking, Known limitation: recovered retry not tracked, RuntimeReliabilityTracker, Why post-settlement and not agent_end

### Community 55 - "remote-prompt.test.ts"
Cohesion: 0.60
Nodes (4): consumeRemoteText(), pendingRemoteTexts, queueRemoteText(), REMOTE_QUEUE_CAP

### Community 56 - "pi-bifrost"
Cohesion: 0.40
Nodes (4): Example dialogue, Flagged ambiguities, Language, pi-bifrost

### Community 57 - "2. `pi-router`: channel routing peer"
Cohesion: 0.40
Nodes (5): 2. `pi-router`: channel routing peer, Architecture, Bifrost lessons, Limits and risks, What it does well

### Community 58 - "3. `pi-failover`: strongest failover/replay warning"
Cohesion: 0.40
Nodes (5): 3. `pi-failover`: strongest failover/replay warning, Architecture, Bifrost conclusion, Safety concern, What it does well

### Community 59 - "4. `pi-triage`: classification and discovery peer"
Cohesion: 0.40
Nodes (5): 4. `pi-triage`: classification and discovery peer, Architecture, Bifrost lessons, Limits and risks, What it does well

### Community 60 - "5. `pi-model-switch`: user/agent control peer"
Cohesion: 0.40
Nodes (5): 5. `pi-model-switch`: user/agent control peer, Architecture, Bifrost lessons, Limits, What it does well

### Community 61 - "reliability"
Cohesion: 0.40
Nodes (5): reliability, cooldownMinutes, enabled, failureThreshold, windowMinutes

### Community 62 - "4.1.0"
Cohesion: 0.50
Nodes (4): 4.1.0, Added, Changed, Notes

### Community 63 - "4.1.2"
Cohesion: 0.50
Nodes (4): 4.1.2, Changed, Fixed, ClassificationSource

### Community 64 - "4.2.0"
Cohesion: 0.50
Nodes (4): 4.2.0, Added, Changed, Fixed

### Community 65 - "4.4.0"
Cohesion: 0.50
Nodes (4): 4.4.0, Added, Changed, Fixed

### Community 66 - "4.5.10 - 29-08-2026"
Cohesion: 0.50
Nodes (4): 4.5.10 - 29-08-2026, Added, Changed, Fixed

### Community 67 - "4.5.21 - 05-09-2026"
Cohesion: 0.50
Nodes (4): 4.5.21 - 05-09-2026, Changed, Fixed, Removed

### Community 68 - "Test infrastructure"
Cohesion: 0.50
Nodes (4): Fake provider E2E: deterministic HTTP/SSE server, Test infrastructure, Unit tests: 146 tests, 48 suites, Visual smoke: unchanged

### Community 69 - "Findings"
Cohesion: 0.50
Nodes (4): Findings, P1 — no post-selection provider-failure feedback loop, P2 — disabled reliability still reports old circuits and writes probe successes, P3 — runtime config validation should match schema integer constraints

### Community 70 - "What each does well"
Cohesion: 0.50
Nodes (4): autopilot lessons, model-fallback lessons, model-router lessons, What each does well

### Community 71 - "Gaps worth considering"
Cohesion: 0.50
Nodes (4): Do not copy without a strong safety case, Gaps worth considering, High-value, low-risk, Medium-value; needs product/design ADR

### Community 72 - "Recommendations"
Cohesion: 0.50
Nodes (4): Adopt conceptually, Do not adopt by default, Recommendations, Study, but defer

### Community 73 - "cache"
Cohesion: 0.50
Nodes (4): cache, enabled, maxEntries, threshold

### Community 74 - "4.10.1 - 19-09-2026"
Cohesion: 0.67
Nodes (3): 4.10.1 - 19-09-2026, Added, Fixed

### Community 75 - "4.14.0 - 30-09-2026"
Cohesion: 0.67
Nodes (3): 4.14.0 - 30-09-2026, Changed, Fixed

### Community 76 - "4.15.2 - 05-10-2026"
Cohesion: 0.67
Nodes (3): 4.15.2 - 05-10-2026, Changed, Fixed

### Community 77 - "4.15.4 - 09-10-2026"
Cohesion: 0.67
Nodes (3): 4.15.4 - 09-10-2026, Changed, Fixed

### Community 78 - "4.15.5 - 15-10-2026"
Cohesion: 0.67
Nodes (3): 4.15.5 - 15-10-2026, Changed, Fixed

### Community 79 - "4.3.0"
Cohesion: 0.67
Nodes (3): 4.3.0, Added, Changed

### Community 80 - "4.4.3"
Cohesion: 0.67
Nodes (3): 4.4.3, Added, Fixed

### Community 81 - "4.5.14 - 01-09-2026"
Cohesion: 0.67
Nodes (3): 4.5.14 - 01-09-2026, Added, Changed

### Community 82 - "4.5.15 - 01-09-2026"
Cohesion: 0.67
Nodes (3): 4.5.15 - 01-09-2026, Added, Changed

### Community 83 - "4.5.16 - 01-09-2026"
Cohesion: 0.67
Nodes (3): 4.5.16 - 01-09-2026, Added, Changed

### Community 84 - "4.5.6 - 29-08-2026"
Cohesion: 0.67
Nodes (3): 4.5.6 - 29-08-2026, Added, Changed

### Community 85 - "4.6.0 - 12-09-2026"
Cohesion: 0.67
Nodes (3): 4.6.0 - 12-09-2026, Added, Changed

### Community 86 - "4.7.0 - 13-09-2026"
Cohesion: 0.67
Nodes (3): 4.7.0 - 13-09-2026, Added, Fixed

### Community 87 - "How to add a feature"
Cohesion: 0.67
Nodes (3): Adding an E2E scenario, Architecture rules, How to add a feature

## Knowledge Gaps
- **15 isolated node(s):** `ADR-0015`, `@types/node`, `agent-tui`, `typescript`, `AGENT_TUI_SOCKET` (+10 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 702 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **39 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `QuotaStore` connect `quota.ts` to `bifrostExtension`, `index.ts`, `routing.ts`?**
  _High betweenness centrality (0.122) - this node is a cross-community bridge._
- **Are the 18 inferred relationships involving `bifrostExtension()` (e.g. with `isJevModelReference()` and `getBifrostCommandCompletions()`) actually correct?**
  _`bifrostExtension()` has 18 INFERRED edges - model-reasoned connections that need verification._
- **What connects `ADR-0015`, `@types/node`, `agent-tui` to the rest of the system?**
  _15 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `config.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06382978723404255 - nodes in this community are weakly interconnected._
- **Why does `Architecture map` connect `quota.ts` to `OpenCode router landscape`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **Should `classifier.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05516431924882629 - nodes in this community are weakly interconnected._
- **Should `reliability.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.14564564564564564 - nodes in this community are weakly interconnected._