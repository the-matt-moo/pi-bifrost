import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { classifyWithLLM as invokeClassifier, type ClassifierModel } from "./classifier.js";

import {
  autoPinSource,
  createPipeline,
  type ClassificationPipeline,
} from "./classification-pipeline.js";
import {
  cachePath,
  lookupCache,
  touchCacheEntry,
  loadCache,
  createDeferredCacheWriter,
  updateCache,
  demoteCacheEntry,
  warmStartCache,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_THRESHOLD,
  type CacheEntry,
} from "./cache.js";
import {
  loadConfig,
  loadRules,
  validateConfig,
  generateTierDescriptions,
  type BifrostConfig,
} from "./config.js";
import {
  billingClass,
  diagnoseCandidates,
  findCandidates,
  getStrategy,
  guessTier,
  isProviderQuotaExhausted,
  modelKey,
  resolveModelWithFallback,
  resolveHealthyModel,
  selectComparableAvailableModel,
  selectImageCapableModelFromGroups,
  supportsImageInput,
} from "./routing.js";
import { QuotaStore } from "./quota.js";
import { ReliabilityStore } from "./reliability-store.js";
import { isRetryableProviderLimit } from "./reliability.js";
import { loadRuntimeState, runtimeStatePath, saveRuntimeState } from "./runtime-state.js";
import { createCommandRouter, getBifrostCommandCompletions, log, logOverwrite, uiBusy, uiDone, setBifrostSilent, syncBifrostModeStatus, clearBifrostWidgets, formatBifrostRouting, type BifrostState } from "./commands.js";
import { setupDebug, debug, debugMeasure } from "./debug.js";
import { parseInlineOverride } from "./inline-override.js";
import {
  formatDiagnostic,
  parseSetModelError,
  patternUnresolvable,
  classifierModelMissing,
} from "./diagnostics.js";
import { RuntimeReliabilityTracker } from "./runtime-reliability.js";
import { assessThinking, clampToModel, compareThinkingLevels, ThinkingSession, type ThinkingDecision, type ThinkingLevel } from "./thinking.ts";
import { SessionRoutingContext } from "./session-context.js";
import {
  REGISTRY_REFRESH_TTL_MS,
  setBifrostStatus,
  setBifrostWorkingMessage,
  shouldRefreshRegistry,
  refreshRegistry,
} from "./ux-status.js";

// ── Pipeline builder (composition root) ────────────────────────

function scopedCandidates(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
) {
  const scoped = new Set(ctx.scopedModels.map(({ model }) => modelKey(model)));
  return findCandidates(ctx, pattern).filter((model) => scoped.has(modelKey(model)));
}

function classifierModelPatterns(config: BifrostConfig): string[] {
  const primary = config.classifier?.model;
  const patterns = [
    ...(Array.isArray(primary) ? primary : primary ? [primary] : []),
    ...(config.classifier?.fallbackModels ?? []),
  ];
  return [...new Set(patterns.filter(Boolean))];
}

function resolveClassifierModels(
  ctx: ExtensionContext,
  config: BifrostConfig,
): ClassifierModel[] {
  const patterns = classifierModelPatterns(config);
  if (patterns.length === 0) return [];

  const endpoint = config.classifier?.endpoint;
  if (endpoint) {
    return patterns.map((id) => endpointClassifier(id, endpoint));
  }

  return scopedCandidates(ctx, patterns).map((model) => ({ kind: "registry" as const, model }));
}

function endpointClassifier(id: string, endpoint: string): ClassifierModel {
  return { kind: "endpoint", id, baseUrl: endpoint };
}

function buildPipeline(
  ctx: ExtensionContext,
  config: BifrostConfig,
  cacheEntries: CacheEntry[],
  classifierEnabled: boolean,
  sessionContext: SessionRoutingContext,
  classifierCooldowns: Map<string, number>,
  scheduleCacheSave: () => void,
): ClassificationPipeline {
  const tiers = Object.keys(config.models ?? {});
  const cacheCfg = config.cache;
  const cacheEnabled = cacheCfg?.enabled ?? true;
  const threshold = cacheCfg?.threshold ?? DEFAULT_THRESHOLD;

  // Resolve classifier models once at pipeline construction.
  // If classifier is disabled, pass empty array — pipeline skips LLM stage.
  const classifierModels = classifierEnabled && tiers.length > 0
    ? resolveClassifierModels(ctx, config)
    : [];

  const rules = loadRules(process.cwd(), config);
  const tierDescriptions = generateTierDescriptions(rules, tiers);

  return createPipeline({
    cacheLookup: (text) => {
      if (!cacheEnabled) return undefined;
      const entry = lookupCache(cacheEntries, text, threshold);
      if (entry) {
        touchCacheEntry(entry);
        scheduleCacheSave();
        return entry.category;
      }
      return undefined;
    },
    classifierModels,
    classifyWithLLM: (model, text, tiers, signal) =>
      invokeClassifier(ctx, model, tiers, text, {
        systemPrompt: config.classifier?.systemPrompt,
        maxTokens: config.classifier?.maxTokens ?? 8,
        temperature: config.classifier?.temperature,
        method: config.classifier?.method,
        tierDescriptions,
        confidenceThreshold: config.classifier?.confidenceThreshold,
        signal: signal && ctx.signal ? AbortSignal.any([signal, ctx.signal]) : (signal ?? ctx.signal),
      }),
    regexRules: rules,
    defaultTier: config.default,
    tiers,
    sessionContext,
    complexityEnabled: true,
    classifierMaxAttempts: config.classifier?.maxAttempts ?? 2,
    classifierTimeoutMs: config.classifier?.timeoutMs ?? 10_000,
    fallbackToRegex: config.classifier?.fallbackToRegex ?? true,
    classifierCooldownMs: (config.classifier?.cooldownSeconds ?? 60) * 1000,
    classifierCooldowns,
  });
}

export default function bifrostExtension(pi: ExtensionAPI) {
  const extensionDir = fileURLToPath(new URL(".", import.meta.url));

  // Setup debug logging first — so startup errors are captured.
  const bootConfig = loadConfig(process.cwd(), extensionDir);
  if (bootConfig.debug?.enabled) {
    setupDebug(bootConfig.debug, process.cwd());
    debug("bifrost", "startup", { extensionDir });
  }

  const config = bootConfig;
  const cacheFilePath = cachePath(process.cwd(), config.cache?.path);

  // Validate config on startup. Errors are logged; the extension
  // continues with best-effort routing for warnings.
  const configIssues = validateConfig(config);
  if (!config.silent) {
    for (const issue of configIssues) {
      const tag = issue.severity === "error" ? "error" : "warning";
      console.error(`[bifrost/config] ${tag}: ${issue.message}`);
    }
  }
  const cacheEntries = loadCache(cacheFilePath);
  const reliabilityStore = new ReliabilityStore({ cwd: process.cwd(), config: config.reliability });
  const quotaStore = new QuotaStore(config.quotaRouting);
  const runtimeStateFile = runtimeStatePath(process.cwd());
  const runtimeState = loadRuntimeState(runtimeStateFile, {
    enabled: config.enabled ?? true,
    pinned: false,
    classifierEnabled: config.classifier?.enabled ?? true,
    thinkingMode: config.thinking?.mode ?? "off",
    silent: config.silent ?? false,
  });
  let selfSelecting = false;
  let selfSettingThinkingLevel: ThinkingLevel | undefined;
  // Pi emits thinking/model events concurrently during a model switch. Ignore thinking
  // changes until that switch's event batch settles; only later changes are manual pins.
  let lastSeenModel: string | undefined;
  let settlingModel: string | undefined;
  const thinkingSession = new ThinkingSession();
  const runtimeReliability = new RuntimeReliabilityTracker();
  const sessionContext = new SessionRoutingContext();
  let lastRoutedPrompt: string | undefined;
  let pipeline: ClassificationPipeline | undefined;
  let startupValidated = false;
  const warnedPatterns = new Set<string>();
  const classifierCooldowns = new Map<string, number>();
  const cacheWriter = createDeferredCacheWriter(cacheFilePath, () => state.cacheEntries);
  process.once("exit", () => cacheWriter.flushSync());

  function getPipeline(ctx: ExtensionContext): ClassificationPipeline {
    if (!pipeline) {
      pipeline = buildPipeline(
        ctx,
        state.config,
        state.cacheEntries,
        state.classifierEnabled,
        sessionContext,
        classifierCooldowns,
        cacheWriter.schedule,
      );
    }
    return pipeline;
  }

  function invalidatePipeline() {
    debug("bifrost", "pipeline.invalidate");
    pipeline = undefined;
  }

  function summarizeQuota(store: QuotaStore): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(store.getSnapshot().byProvider)) {
      const weekly =
        typeof v.weeklyRemainingFraction === "number"
          ? (v.weeklyRemainingFraction * 100).toFixed(0) + "%"
          : "?";
      const session =
        typeof v.sessionRemainingFraction === "number"
          ? ` sess ${(v.sessionRemainingFraction * 100).toFixed(0)}%`
          : "";
      out[k] = weekly + session;
    }
    return out;
  }

  // Mutable state shared with command handlers.
  const state: BifrostState = {
    config,
    enabled: runtimeState.enabled,
    classifierEnabled: runtimeState.classifierEnabled,
    thinkingMode: runtimeState.thinkingMode ?? "off",
    thinkingPinned: false,
    thinkingLevel: "off",
    pinned: runtimeState.pinned,
    silent: runtimeState.silent,
    cacheEntries,
    reliabilityStore,
    extensionDir,
    getPipeline,
    invalidatePipeline,
    saveModeState: () => saveRuntimeState(runtimeStateFile, {
      enabled: state.enabled,
      classifierEnabled: state.classifierEnabled,
      thinkingMode: state.thinkingMode,
      silent: state.silent,
    }),
    lastRegistryRefreshAt: undefined,
    forceRegistryRefresh: false,
    refreshRegistry: (ctx) => refreshRegistry(
      state,
      () => ctx.modelRegistry.refresh(),
      invalidatePipeline,
    ),
    scheduleCacheSave: cacheWriter.schedule,
    flushCacheSave: cacheWriter.flush,
  };



  function inferPattern(ctx: ExtensionContext, tier: string): string[] {
    const raw = state.config.models?.[tier];
    if (raw && (!Array.isArray(raw) || raw.length > 0)) {
      return scopedCandidates(ctx, raw).map(modelKey);
    }
    // Unconfigured tiers may derive candidates only from Pi's scoped-model selection.
    // "writing" has no guessTier class; alias to "general" for candidate lookup.
    const inferredTier = tier === "writing" ? "general" : tier;
    return ctx.scopedModels
      .map(({ model }) => model)
      .filter((model) => guessTier(model) === inferredTier)
      .map(modelKey);
  }

  function resolveImageCapableFallback(
    ctx: ExtensionContext,
    startTier: string,
  ): { tier: string; model: Model<Api> } | undefined {
    const tiers = Object.keys(state.config.models ?? {});
    const startIndex = tiers.indexOf(startTier);
    const searchTiers = startIndex >= 0 ? tiers.slice(startIndex) : tiers;
    const now = Date.now();
    const quota = quotaStore.getSnapshot();
    const reliabilityState = state.reliabilityStore.getState();
    const groups = searchTiers.map((tier) => {
      const pattern = inferPattern(ctx, tier);
      const strategy = getStrategy(state.config.categoryStrategies, state.config.strategy, tier);
      const resolved = resolveHealthyModel(
        ctx,
        pattern,
        strategy,
        reliabilityState,
        state.config.reliability,
        now,
        quota,
        state.config.quotaRouting,
        undefined,
        tier,
      );
      return {
        tier,
        candidates: resolved.healthyCandidates,
        strategy,
      };
    });
    const selected = selectImageCapableModelFromGroups(groups);
    return selected ? { tier: selected.tier, model: selected.model } : undefined;
  }

  function decideThinking(
    prompt: string,
    selectedTier: string,
    model: Model<Api> | undefined,
    preview = false,
  ) {
    const thinkingConfig = state.config.thinking;
    const rawDecision = assessThinking({
      text: prompt,
      turnDepth: thinkingSession.turnDepth(prompt),
      lastTurnFailed: thinkingSession.getLastTurnOutcome().failed,
      lastTurnErrored: thinkingSession.getLastTurnOutcome().errored,
    });
    const decision: ThinkingDecision = rawDecision.defaulted
      ? { ...rawDecision, level: thinkingConfig?.defaultLevel ?? "medium", defaulted: true }
      : rawDecision;
    const reasons = decision.reasons.length > 0 ? [...decision.reasons] : ["configured default"];
    let level = decision.level;
    const sticky = thinkingSession.suggest(prompt, !preview);
    if (sticky && compareThinkingLevels(level, sticky) < 0) {
      level = sticky;
      reasons.push(`sticky task floor ${sticky}`);
    }
    const free = model !== undefined && billingClass(model) === "free";
    if (free) {
      reasons.push("free model maximum");
    } else {
      const cap = thinkingConfig?.maxLevel ?? "high";
      if (compareThinkingLevels(level, cap) > 0) {
        level = cap;
        reasons.push(`maximum ${cap}`);
      }
      const tierCap = thinkingConfig?.byTier?.[selectedTier];
      if (tierCap && compareThinkingLevels(level, tierCap) > 0) {
        level = tierCap;
        reasons.push(`${selectedTier} tier maximum ${tierCap}`);
      }
    }
    const clamp = clampToModel(level, model ?? {}, free);
    if (clamp.reason) reasons.push(clamp.reason);
    const readableReasons = reasons.map((reason) => reason.replace(/^[+-]\d+\s+/, "").replaceAll("-", " "));
    return {
      level: clamp.level,
      score: decision.score,
      reasons,
      summary: `score ${decision.score}: ${readableReasons.join(", ")}`,
    };
  }

  state.previewThinking = (prompt, selectedTier, model) => {
    if (state.thinkingPinned) {
      return { level: state.thinkingLevel, mode: "pinned", summary: "manual thinking level is pinned" };
    }
    if (state.thinkingMode === "off") {
      return { level: state.thinkingLevel, mode: "off", summary: "automatic thinking selection is disabled" };
    }
    const decision = decideThinking(prompt, selectedTier, model, true);
    return { level: decision.level, mode: state.thinkingMode, summary: decision.summary };
  };

  const handleCommand = createCommandRouter(state);

  pi.registerCommand("bifrost", {
    description: "Bifrost model router control",
    getArgumentCompletions: getBifrostCommandCompletions,
    handler: async (args, ctx) => {
      await handleCommand(args, ctx);
    },
  });

  // Keys are machine-local (bifrost.json "keys"), never hardcoded: layouts and host
  // keybindings differ per machine, and Pi's extension API takes literal keys only.
  // Keys reserved by the host (e.g. shift+tab) are skipped with a startup diagnostic.
  if (state.config.keys?.pin) {
    pi.registerShortcut(state.config.keys.pin as Parameters<typeof pi.registerShortcut>[0], {
      description: "Pin Bifrost to the current model",
      handler: async (ctx) => {
        state.pinned = true;
        state.saveModeState();
        lastSeenModel = modelKey(ctx.model);
        syncBifrostModeStatus(ctx, state);
        clearBifrostWidgets(ctx);
        log(ctx, `Bifrost pinned to ${modelKey(ctx.model)}`);
      },
    });
  }

  if (state.config.keys?.unpin) {
    pi.registerShortcut(state.config.keys.unpin as Parameters<typeof pi.registerShortcut>[0], {
    description: "Unpin Bifrost model and thinking",
    handler: async (ctx) => {
      const wasPinned = state.pinned || state.thinkingPinned;
      state.pinned = false;
      state.thinkingPinned = false;
      state.thinkingMode = "apply";
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, wasPinned ? "Bifrost unpinned (model + thinking)" : "Bifrost already unpinned");
    },
    });
  }

  if (state.config.keys?.toggle) {
    pi.registerShortcut(state.config.keys.toggle as Parameters<typeof pi.registerShortcut>[0], {
      description: "Toggle Bifrost pin on current model",
      handler: async (ctx) => {
        if (state.pinned) {
          state.pinned = false;
          state.thinkingPinned = false;
          state.thinkingMode = "apply";
          state.saveModeState();
          syncBifrostModeStatus(ctx, state);
          clearBifrostWidgets(ctx);
          log(ctx, `Bifrost unpinned (was ${modelKey(ctx.model)})`);
        } else {
          state.pinned = true;
          state.saveModeState();
          lastSeenModel = modelKey(ctx.model);
          syncBifrostModeStatus(ctx, state);
          clearBifrostWidgets(ctx);
          log(ctx, `Bifrost pinned to ${modelKey(ctx.model)}`);
        }
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    state.thinkingLevel = pi.getThinkingLevel();
    lastSeenModel = modelKey(ctx.model);
    setBifrostSilent(ctx, state.silent);
    syncBifrostModeStatus(ctx, state);
    clearBifrostWidgets(ctx);
    void quotaStore.refreshIfStale(Date.now());

    // Warm-start cache if empty
    if (state.cacheEntries.length === 0) {
      const rules = loadRules(process.cwd(), state.config);
      const tiers = Object.keys(state.config.models ?? {});
      const maxEntries = state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES;
      state.cacheEntries = warmStartCache(state.cacheEntries, rules, tiers, maxEntries);
      if (state.cacheEntries.length > 0) {
        cacheWriter.schedule();
        invalidatePipeline();
        debug("cache", "warm_start", { entries: state.cacheEntries.length });
      }
    }

    if (!startupValidated && state.enabled) {
      startupValidated = true;
      for (const [tier, patterns] of Object.entries(state.config.models ?? {})) {
        const { unresolved } = diagnoseCandidates(ctx, patterns);
        for (const p of unresolved) {
          log(ctx, formatDiagnostic(patternUnresolvable(tier, p)), "warning");
        }
      }
      const classifierPattern = state.config.classifier?.model;
      if (classifierPattern && state.classifierEnabled) {
        const { candidates } = diagnoseCandidates(ctx, classifierPattern);
        if (candidates.length === 0) {
          const patternStr = Array.isArray(classifierPattern) ? classifierPattern[0] : classifierPattern;
          log(ctx, formatDiagnostic(classifierModelMissing(patternStr)), "warning");
        }
      }
    }
  });

  pi.on("agent_end", async (event) => {
    runtimeReliability.observe(event.messages);
  });

  pi.on("turn_end", async (event) => {
    runtimeReliability.noteToolResults(event.toolResults);
    const failed = event.toolResults.some((result) => result.isError === true);
    const errored = (event.message as { stopReason?: unknown })?.stopReason === "error";
    thinkingSession.noteTurnOutcome(failed, errored);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    setBifrostSilent(ctx, state.silent);
    const settled = runtimeReliability.settle();
    if (!settled || !state.enabled || state.config.reliability?.enabled === false) return;
    // Policy A: failure logged, clean settle silent (trial-only success).
    // Intentional — normal routing produces no log noise.
    state.reliabilityStore.recordSettled(settled.model, settled.reason);
    if (!settled.reason) return;

    const httpMatch = settled.reason.match(/\b([45]\d{2})\b/);
    const detail = httpMatch ? `HTTP ${httpMatch[1]}; ` : "";
    const retry = settled.retry;
    const autoRetry = state.config.reliability?.autoRetry ?? true;
    const maxAutoRetries = state.config.reliability?.maxAutoRetries ?? 2;
    if (
      !autoRetry ||
      !retry ||
      !settled.replaySafe ||
      !isRetryableProviderLimit(settled.reason) ||
      retry.autoRetryCount >= maxAutoRetries
    ) {
      // Auto-unpin on retryable provider errors (429, rate limit) so next prompt
      // routes to a healthy model instead of hitting the same wall.
      if (state.pinned && isRetryableProviderLimit(settled.reason)) {
        state.pinned = false;
        state.saveModeState();
        syncBifrostModeStatus(ctx, state);
        log(ctx, `Bifrost: ${settled.model} is rate-limited (${detail}circuit opened); auto-unpinned to allow routing to a healthy model.`, "warning");
        return;
      }
      const why = isRetryableProviderLimit(settled.reason) && !settled.replaySafe
        ? " automatic retry skipped because the failed turn produced output or tool results."
        : " next prompt routes to the next healthy model in its tier.";
      log(ctx, `Bifrost: provider failure for ${settled.model} (${detail}circuit opened);${why}`, "warning");
      return;
    }

    const tier = retry.tier;
    const strategy = getStrategy(state.config.categoryStrategies, state.config.strategy, tier);
    const defaultTier = state.config.default;
    const resolved = resolveModelWithFallback(ctx, {
      requestedTier: tier,
      requestedPattern: inferPattern(ctx, tier),
      requestedStrategy: strategy,
      defaultTier,
      defaultPattern: defaultTier ? inferPattern(ctx, defaultTier) : undefined,
      defaultStrategy: defaultTier
        ? getStrategy(state.config.categoryStrategies, state.config.strategy, defaultTier)
        : strategy,
      reliabilityState: state.reliabilityStore.getState(),
      reliabilityConfig: state.config.reliability,
      quota: quotaStore.getSnapshot(),
      quotaConfig: state.config.quotaRouting,
    });
    const next = resolved.selected;
    if (!next) {
      log(ctx, `Bifrost: provider failure for ${settled.model} (${detail}circuit opened); no healthy retry model is available.`, "warning");
      return;
    }

    const nextKey = modelKey(next);
    selfSelecting = true;
    let switched = false;
    let switchError: unknown;
    try {
      switched = await pi.setModel(next);
    } catch (err) {
      switchError = err;
    }
    if (!switched) {
      selfSelecting = false;
      const diagnostic = parseSetModelError(switchError, nextKey);
      state.reliabilityStore.recordFailure(nextKey, "setModel", diagnostic.message);
      log(ctx, `Bifrost: retry model switch failed: ${formatDiagnostic(diagnostic)}`, "error");
      return;
    }

    const nextRetry = { ...retry, autoRetryCount: retry.autoRetryCount + 1 };
    runtimeReliability.begin(nextKey, nextRetry);
    const replayContent = retry.images?.length
      ? [...(retry.prompt ? [{ type: "text" as const, text: retry.prompt }] : []), ...retry.images]
      : retry.prompt;
    log(ctx, `Bifrost: ${settled.model} was rate-limited; auto-retrying on ${nextKey} (${nextRetry.autoRetryCount}/${maxAutoRetries}).`, "warning");
    pi.sendUserMessage(replayContent, { deliverAs: "followUp" });
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (selfSettingThinkingLevel === event.level) {
      selfSettingThinkingLevel = undefined;
      state.thinkingLevel = event.level;
      lastSeenModel = modelKey(ctx.model);
      return;
    }
    state.thinkingLevel = event.level;
    const currentModel = modelKey(ctx.model);
    if (currentModel !== lastSeenModel || currentModel === settlingModel) {
      debug("bifrost", "thinking_clamped_on_model_switch", { level: event.level, model: currentModel });
      return;
    }
    state.thinkingPinned = true;
    thinkingSession.reset();
    syncBifrostModeStatus(ctx, state);
    log(ctx, `Thinking level manually changed to ${event.level}; Bifrost thinking pinned.`);
  });

  pi.on("model_select", async (_event, ctx) => {
    setBifrostSilent(ctx, state.silent);
    const selectedModel = modelKey(ctx.model);
    settlingModel = selectedModel;
    setTimeout(() => {
      if (settlingModel !== selectedModel) return;
      lastSeenModel = selectedModel;
      settlingModel = undefined;
    }, 0);
    if (selfSelecting) {
      selfSelecting = false;
      return;
    }
    if (!state.enabled) return;

    if (lastRoutedPrompt) {
      const tiers = Object.keys(state.config.models ?? {});
      const escalated = demoteCacheEntry(state.cacheEntries, lastRoutedPrompt, tiers);
      if (escalated) {
        cacheWriter.schedule();
        invalidatePipeline();
        debug("feedback", "demotion_escalated", { prompt: lastRoutedPrompt.slice(0, 50) });
      }
      lastRoutedPrompt = undefined;
    }

    sessionContext.reset();
    state.pinned = true;
    state.saveModeState();
    debug("bifrost", "model_select", { model: selectedModel });
    syncBifrostModeStatus(ctx, state);
    clearBifrostWidgets(ctx);
    logOverwrite(
      ctx,
      `Model manually changed to ${selectedModel}; Bifrost pinned.`,
    );
  });

  pi.on("input", async (event, ctx) => {
    setBifrostSilent(ctx, state.silent);
    // Safety: clear any guard left unconsumed from the previous turn so it can't wedge.
    // The current turn's thinking_level_select has already been delivered by now.
    selfSettingThinkingLevel = undefined;
    lastSeenModel = modelKey(ctx.model);
    if (event.source === "extension") return { action: "continue" };
    clearBifrostWidgets(ctx);
    // Passive subagent observation — logged even when routing is disabled,
    // so child-session model usage stays visible in debug logs.
    if (process.env.PI_SUBAGENT_RUN_ID) {
      debug("input", "subagent", {
        source: "PI-subagent",
        agent: process.env.PI_SUBAGENT_CHILD_AGENT,
        model: modelKey(ctx.model),
        thinkingLevel: ctx.thinkingLevel,
        depth: process.env.PI_SUBAGENT_PARENT_DEPTH,
      });
    }
    if (!state.enabled) {
      debug("input", "bypass", { enabled: false, pinned: state.pinned });
      syncBifrostModeStatus(ctx, state);
      return { action: "continue" };
    }

    const text = event.text.trim();
    if (text.startsWith("/")) return { action: "continue" };

    // Inline tier override: "frontier debug this" forces that tier for one prompt.
    // Pi reserves / for commands, ! for bash. Just type the tier name as first word.
    const { forcedTier, promptText } = parseInlineOverride(text, state.config.models);
    if (forcedTier) debug("input", "inline_override", { tier: forcedTier });

    // Inline override should strip the tier keyword from what LLM sees.
    const defaultAction = forcedTier
      ? { action: "transform" as const, text: promptText }
      : { action: "continue" as const };

    if (state.pinned) {
      const now = Date.now();
      await quotaStore.refreshIfStale(now);
      const current = ctx.model;
      const quota = quotaStore.getSnapshot();
      if (current && isProviderQuotaExhausted(current, quota, state.config.quotaRouting, now)) {
        const tier = guessTier(current);
        const replacement = selectComparableAvailableModel(
          current,
          ctx.scopedModels.map(({ model }) => model),
          getStrategy(state.config.categoryStrategies, state.config.strategy, tier),
          quota,
          state.config.quotaRouting,
          now,
        );
        if (replacement) {
          selfSelecting = true;
          let switched = false;
          try {
            switched = await pi.setModel(replacement);
          } catch (err) {
            debug("input", "exhausted_pin_switch_failed", { model: modelKey(replacement), error: String(err) });
          }
          if (switched) {
            state.pinned = false;
            state.saveModeState();
            syncBifrostModeStatus(ctx, state);
            log(ctx, `Bifrost: ${modelKey(current)} reached its usage limit; unpinned and switched to comparable ${modelKey(replacement)}.`, "warning");
            return defaultAction;
          }
          selfSelecting = false;
          log(ctx, `Bifrost: ${modelKey(current)} reached its usage limit, but switching to ${modelKey(replacement)} failed; pin retained.`, "error");
        } else {
          log(ctx, `Bifrost: ${modelKey(current)} reached its usage limit; no comparable scoped model with available quota was found, so the pin was retained.`, "warning");
        }
      }

      if (!forcedTier && !sessionContext.isClearlyUnrelated(promptText)) {
        sessionContext.record(ctx.model ? guessTier(ctx.model) : (state.config.default ?? "general"), promptText);
        debug("input", "bypass", { enabled: true, pinned: true });
        syncBifrostModeStatus(ctx, state);
        log(ctx, formatBifrostRouting("", modelKey(ctx.model), "", true));
        return defaultAction;
      }

      state.pinned = false;
      sessionContext.reset();
      const reason = forcedTier ? "manual inline override" : "unrelated topic";
      debug("input", "auto_unpin", { reason });
      log(ctx, `Bifrost unpinned for ${reason}.`);
    }

    const endInput = debugMeasure("input", "total");
    debug("input", "prompt", { length: promptText.length });

    const mustRefreshRegistry = state.forceRegistryRefresh || ctx.modelRegistry.getAvailable().length === 0;
    const shouldRefresh = state.classifierEnabled && (
      mustRefreshRegistry ||
      (!state.registryRefreshInflight && shouldRefreshRegistry(state, Date.now(), REGISTRY_REFRESH_TTL_MS))
    );

    try {
      if (shouldRefresh) {
        const mustWait = mustRefreshRegistry;
        if (mustWait) setBifrostWorkingMessage(ctx, "Bifrost checking models...");
        const endRefresh = debugMeasure("input", "registry.refresh");
        const refresh = state.refreshRegistry(ctx).then((ok) => {
          endRefresh({ background: !mustWait, ok });
          if (!ok) debug("input", "registry.refresh.error");
          return ok;
        });
        if (mustWait && !(await refresh)) {
          log(ctx, "model registry refresh failed; using current snapshot", "warning");
        } else if (!mustWait) {
          void refresh;
        }
      }

      setBifrostStatus(ctx, forcedTier ? `using ${forcedTier}...` : "classifying prompt...", "accent");
      uiBusy(ctx, forcedTier ? `Bifrost using ${forcedTier}...` : "Bifrost classifying...");
      setBifrostWorkingMessage(ctx, forcedTier ? `Bifrost using ${forcedTier}...` : "Bifrost classifying...");
      const endClassify = debugMeasure("input", "classify");
      const classification = forcedTier
        ? { kind: "classified" as const, tier: forcedTier, source: "inline" as const }
        : await getPipeline(ctx).classify(promptText);

      if (classification.kind === "classified") {
        const tag = classification.source === "inline" ? "!" : classification.source;
        log(ctx, `classify: ${classification.tier} [${tag}]`);
        lastRoutedPrompt = promptText;
      }
      if (classification.kind !== "unclassified") {
        sessionContext.record(classification.tier, promptText);
      }

      void quotaStore.refreshIfStale(Date.now());

      endClassify({ kind: classification.kind, tier: classification.kind !== "unclassified" ? classification.tier : undefined });
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);

      if (classification.kind === "unclassified") {
        log(ctx, "Bifrost: no tier matched — using default model", "warning");
        debug("input", "unclassified");
        syncBifrostModeStatus(ctx, state);
        endInput();
        return defaultAction;
      }

      const tier = classification.tier;
      const source = classification.kind === "classified"
        ? classification.source
        : "fallback";
      const pinSource = autoPinSource(classification);
      const pattern = inferPattern(ctx, tier);
      let strategy = getStrategy(state.config.categoryStrategies, state.config.strategy, tier);
      const defaultTier = state.config.default;
      const defaultPattern = defaultTier ? inferPattern(ctx, defaultTier) : undefined;
      const defaultStrategy = defaultTier
        ? getStrategy(state.config.categoryStrategies, state.config.strategy, defaultTier)
        : strategy;

      const { candidates: requestedCandidates, unresolved } = diagnoseCandidates(ctx, pattern);
      for (const p of unresolved) {
        const warnKey = `${tier}:${p}`;
        if (!warnedPatterns.has(warnKey)) {
          warnedPatterns.add(warnKey);
          log(ctx, formatDiagnostic(patternUnresolvable(tier, p)), "warning");
        }
      }

      const resolved = resolveModelWithFallback(ctx, {
        requestedTier: tier,
        requestedPattern: pattern,
        requestedStrategy: strategy,
        defaultTier,
        defaultPattern,
        defaultStrategy,
        reliabilityState: state.reliabilityStore.getState(),
        reliabilityConfig: state.config.reliability,
        quota: quotaStore.getSnapshot(),
        quotaConfig: state.config.quotaRouting,
        requestedCandidates,
      });
      let model = resolved.selected;
      let selectedTier = resolved.selectedTier ?? tier;
      let visionFallback = false;
      if (model && event.images?.length && !supportsImageInput(model)) {
        const fallback = resolveImageCapableFallback(ctx, selectedTier);
        if (fallback) {
          model = fallback.model;
          selectedTier = fallback.tier;
          strategy = getStrategy(state.config.categoryStrategies, state.config.strategy, selectedTier);
          visionFallback = true;
        }
      }
      const retryContext = {
        prompt: promptText,
        images: event.images ? [...event.images] : undefined,
        tier,
        autoRetryCount: 0,
      };

      // If selected model is half-open, mark trial in progress
      if (model) {
        const circuit = state.reliabilityStore.getCircuitState(modelKey(model));
        if (circuit.halfOpen && !circuit.trialActive) {
          state.reliabilityStore.beginTrial(modelKey(model));
        }
      }

      if (!model) {
        state.forceRegistryRefresh = true;
        debug("input", "no_model", { tier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped.length });
        const why = resolved.fallbackReason ? ` (${resolved.fallbackReason})` : "";
        log(ctx, `Bifrost: tier "${tier}" matched but no healthy model available${why}`, "warning");
        syncBifrostModeStatus(ctx, state);
        endInput();
        return defaultAction;
      }

      if (
        classification.kind === "classified" &&
        classification.source === "classifier"
      ) {
        const maxEntries = state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES;
        if (state.config.cache?.enabled ?? true) {
          const endCacheSave = debugMeasure("input", "cacheSave");
          state.cacheEntries = updateCache(state.cacheEntries, promptText, tier, maxEntries);
          cacheWriter.schedule();
          invalidatePipeline();
          endCacheSave({ entries: state.cacheEntries.length });
        }
      }

      const applyThinking = () => {
        if (state.thinkingMode === "off" || state.thinkingPinned) return;
        const decision = decideThinking(promptText, selectedTier, model);
        state.lastThinkingDecision = { score: decision.score, level: decision.level, reasons: decision.reasons };
        thinkingSession.record(decision.level, promptText);
        if (state.thinkingMode === "apply" && decision.level !== pi.getThinkingLevel()) {
          selfSettingThinkingLevel = decision.level;
          pi.setThinkingLevel(decision.level);
          state.thinkingLevel = pi.getThinkingLevel();
          // ponytail: do NOT clear the guard here. thinking_level_select fires async, after this
          // block returns; the handler consumes & clears selfSettingThinkingLevel on match. Clearing
          // synchronously let the event reach the handler with guard already undefined -> false
          // "Thinking level manually changed" log.
        }
        log(ctx, `thinking: ${state.thinkingMode} ${decision.level} (${decision.summary})`);
      };

      if (modelKey(model) === modelKey(ctx.model)) {
        if (!state.pinned && pinSource) {
          state.pinned = true;
          debug("input", "auto_pin", { model: modelKey(model), source: pinSource });
          log(ctx, `Bifrost auto-pinned to ${modelKey(model)} [${pinSource}]`);
        }
        applyThinking();
        uiDone(ctx);
        syncBifrostModeStatus(ctx, state);
        const reason = resolved.fallbackReason ? `, ${resolved.fallbackReason}` : "";
        log(ctx, formatBifrostRouting(tier, modelKey(model), `already active, ${source}${reason}`));
        debug("input", "model_unchanged", { model: modelKey(model), selectedTier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped.length, thinkingLevel: ctx.thinkingLevel });
        debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason, thinkingLevel: ctx.thinkingLevel, quota: summarizeQuota(quotaStore) });
        runtimeReliability.begin(modelKey(model), retryContext);
        endInput({ model: modelKey(model), tier: selectedTier, strategy, source, thinkingLevel: ctx.thinkingLevel });
        return defaultAction;
      }

      uiBusy(ctx, `Bifrost routing to ${modelKey(model)}...`);
      setBifrostWorkingMessage(ctx, `Bifrost routing to ${modelKey(model)}...`);

      selfSelecting = true;
      const endSwitch = debugMeasure("input", "setModel");
      let ok = false;
      let setModelError: unknown;
      try {
        ok = await pi.setModel(model);
      } catch (err) {
        setModelError = err;
        debug("input", "setModel.throw", { model: modelKey(model), error: String(err) });
      }
      endSwitch({ model: modelKey(model), ok });
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);
      // Auto-pin automatic routing, including fallback, after a successful switch.
      // Explicit inline overrides stay one-shot (session-local, ADR-0015).
      if (ok && !state.pinned && pinSource) {
        state.pinned = true;
        debug("input", "auto_pin", { model: modelKey(model), source: pinSource });
        log(ctx, `Bifrost auto-pinned to ${modelKey(model)} [${pinSource}]`);
      }

      if (!ok) {
        selfSelecting = false;
        state.forceRegistryRefresh = true;
        const diagnostic = parseSetModelError(setModelError, modelKey(model));
        state.reliabilityStore.recordFailure(modelKey(model), "setModel", diagnostic.message);
        syncBifrostModeStatus(ctx, state);
        log(ctx, `Bifrost: ${formatDiagnostic(diagnostic)}`, "error");
        endInput({ model: modelKey(model), ok: false });
        return defaultAction;
      }

      applyThinking();

      const detail = [
        selectedTier !== tier ? `selected tier ${selectedTier}` : undefined,
        visionFallback ? "vision-capable fallback" : undefined,
        resolved.fallbackReason,
        resolved.skipped.length > 0 ? `${resolved.skipped.length} skipped` : undefined,
      ].filter(Boolean).join(", ");
      const doneMsg = classification.kind === "classified"
        ? formatBifrostRouting(tier, modelKey(model), `${classification.source}${detail ? `; ${detail}` : ""}`)
        : formatBifrostRouting(tier, modelKey(model), `fallback${detail ? `; ${detail}` : ""}`);
      syncBifrostModeStatus(ctx, state);
      log(ctx, doneMsg);
      runtimeReliability.begin(modelKey(model), retryContext);
      debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason, thinkingLevel: ctx.thinkingLevel, quota: summarizeQuota(quotaStore) });
      endInput({ model: modelKey(model), tier: selectedTier, strategy, source, thinkingLevel: ctx.thinkingLevel });
      return defaultAction;
    } finally {
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);
      syncBifrostModeStatus(ctx, state);
    }
  });
}
