import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyWithLLM as invokeClassifier,
  jevClassifierForReference,
  isJevModelReference,
  type ClassifierModel,
} from "./classifier.js";

import {
  autoPinSource,
  createPipeline,
  frontierSystemPrompt,
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
  isStrictCategory,
  type BifrostConfig,
} from "./config.js";
import {
  billingClass,
  diagnoseCandidates,
  applySubscriptionGuard,
  configuredCategory,
  getStrategy,
  guessTier,
  isProviderQuotaExhausted,
  isProviderSessionExhausted,
  modelKey,
  resolveModelWithFallback,
  resolveHealthyModel,
  retryUnavailableResolution,
  scopedCandidates,
  selectImageCapableModelFromGroups,
  supportsImageInput,
} from "./routing.js";
import { QuotaStore } from "./quota.js";
import { ReliabilityStore } from "./reliability-store.js";
import { isRetryableProviderError, isRetryableProviderLimit } from "./reliability.js";
import { loadRuntimeState, runtimeStatePath, saveRuntimeState, DEFAULT_RUNTIME_STATE, type RuntimeModeState } from "./runtime-state.js";
import { cleanupSessionState, scheduleSessionCleanup } from "./session-cleanup.js";
import { createCommandRouter, getBifrostCommandCompletions, log, logOverwrite, uiBusy, uiDone, setBifrostSilent, syncBifrostModeStatus, clearBifrostWidgets, formatBifrostRouting, isChildSession, type BifrostState } from "./commands.js";
import { setupDebug, debug, debugMeasure } from "./debug.js";
import { parseInlineOverride } from "./inline-override.js";
import {
  formatDiagnostic,
  parseSetModelError,
  patternUnresolvable,
  classifierModelMissing,
} from "./diagnostics.js";
import { RuntimeReliabilityTracker } from "./runtime-reliability.js";
import { CONTINUATION, completedTools, createHandoff, isCreditsRequired, selectHandoffModel } from "./handoff.ts";
import { handleRpcRequest } from "./rpc.js";
import { assessThinking, capThinkingLevel, clampToModel, compareThinkingLevels, ThinkingSession, type ThinkingDecision, type ThinkingLevel } from "./thinking.ts";
import { SessionRoutingContext } from "./session-context.js";
import {
  REGISTRY_REFRESH_TTL_MS,
  setBifrostStatus,
  setBifrostWorkingMessage,
  shouldRefreshRegistry,
  refreshRegistry,
} from "./ux-status.js";

import { queueRemoteText, consumeRemoteText } from "./remote-signal.js";

// ── Pipeline builder (composition root) ────────────────────────

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

  const seen = new Set<string>();
  return patterns.flatMap<ClassifierModel>((pattern) => {
    const jev = jevClassifierForReference(pattern, config.classifier?.jevCredentialTarget);
    if (jev) return [jev];
    return scopedCandidates(ctx, pattern)
      .filter((model) => {
        const key = modelKey(model);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((model) => ({ kind: "registry" as const, model }));
  });
}

function endpointClassifier(id: string, endpoint: string): ClassifierModel {
  return { kind: "endpoint", id, baseUrl: endpoint };
}

function buildPipeline(
  ctx: ExtensionContext,
  config: BifrostConfig,
  getCacheEntries: () => CacheEntry[],
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
  const tierDescriptions = generateTierDescriptions(rules, tiers, config.classifier?.categoryDescriptions);

  return createPipeline({
    cacheLookup: (text) => {
      if (!cacheEnabled) return undefined;
      const entry = lookupCache(getCacheEntries(), text, threshold);
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
  let activeContext: ExtensionContext | undefined;
  const quotaStore = new QuotaStore(
    config.quotaRouting,
    undefined,
    async (provider) => activeContext?.modelRegistry.getProviderAuth(provider),
  );
  let runtimeStateFile = runtimeStatePath(process.cwd());
  let runtimeState: RuntimeModeState = loadRuntimeState(runtimeStateFile, {
    ...DEFAULT_RUNTIME_STATE,
    enabled: config.enabled ?? true,
    classifierEnabled: config.classifier?.enabled ?? true,
    thinkingMode: config.thinking?.mode ?? "off",
    silent: config.silent ?? false,
  });
  const cleanupTimer = scheduleSessionCleanup();
  process.once("exit", () => clearInterval(cleanupTimer));
  let selfSelecting = false;
  let selfSettingThinkingLevel: ThinkingLevel | undefined;
  // Pi emits thinking/model events concurrently during a model switch. Ignore thinking
  // changes until that switch's event batch settles; only later changes are manual pins.
  let lastSeenModel: string | undefined;
  let settlingModel: string | undefined;
  const thinkingSession = new ThinkingSession();
  const runtimeReliability = new RuntimeReliabilityTracker();
  let pendingHandoff: { target: string; content: string } | undefined;

  function branch(ctx: ExtensionContext) {
    const activeBranch = ctx.sessionManager?.getBranch?.() ?? [];
    // Honor branch-relative redactions and compaction; never resurrect omitted raw history.
    const projection = ctx.sessionManager?.buildSessionProjection?.();
    return projection ? projection.messages.map((message) => ({ type: "message" as const, message })) : activeBranch;
  }

  function hasImages(ctx: ExtensionContext): boolean {
    return branch(ctx).some((entry) => entry.type === "message" && "content" in entry.message && Array.isArray(entry.message.content)
      && entry.message.content.some((block) => block.type === "image"));
  }

  async function switchForHandoff(ctx: ExtensionContext, current: Model<Api>, tier: string | undefined, images: boolean): Promise<Model<Api> | undefined> {
    const next = selectHandoffModel(ctx, state.config, current, tier, state.reliabilityStore.getState(), quotaStore.getSnapshot(), images);
    if (!next || !tier) return undefined;
    const document = createHandoff(branch(ctx), modelKey(current), modelKey(next), tier);
    selfSelecting = true;
    let ok = false;
    try { ok = await pi.setModel(next); } catch { /* handled below */ }
    // A host may not emit model_select for a no-op or failed selection.
    selfSelecting = false;
    if (!ok) {
      state.reliabilityStore.recordFailure(modelKey(next), "setModel", "handoff model switch failed");
      return undefined;
    }
    pendingHandoff = { target: modelKey(next), content: document };
    state.modelCategory = tier;
    state.pinned = false;
    state.saveModeState();
    syncBifrostModeStatus(ctx, state);
    return next;
  }
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
        () => state.cacheEntries,
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
    modelCategory: undefined,
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
    removedScopedModelKeys: new Set(),
    refreshRegistry: (ctx) => refreshRegistry(
      state,
      () => typeof ctx.modelRegistry?.refresh === "function"
        ? ctx.modelRegistry.refresh()
        : Promise.resolve(),
      invalidatePipeline,
    ),
    scheduleCacheSave: cacheWriter.schedule,
    flushCacheSave: cacheWriter.flush,
  };

  function applyRuntimeState(nextFile: string, nextState: RuntimeModeState): void {
    runtimeStateFile = nextFile;
    runtimeState = nextState;
    state.enabled = nextState.enabled;
    state.classifierEnabled = nextState.classifierEnabled;
    state.thinkingMode = nextState.thinkingMode ?? state.thinkingMode;
    state.pinned = false;
    state.silent = nextState.silent;
  }

  function loadSessionRuntimeState(sessionId?: string): void {
    const globalPath = runtimeStatePath(process.cwd());
    const scopedPath = runtimeStatePath(process.cwd(), sessionId);
    const fallback: RuntimeModeState = {
      ...DEFAULT_RUNTIME_STATE,
      enabled: config.enabled ?? true,
      classifierEnabled: config.classifier?.enabled ?? true,
      thinkingMode: config.thinking?.mode ?? "off",
      silent: config.silent ?? false,
    };
    const globalState = loadRuntimeState(globalPath, fallback);
    if (sessionId) {
      if (!existsSync(scopedPath) && existsSync(globalPath)) {
        saveRuntimeState(scopedPath, globalState);
      }
      applyRuntimeState(scopedPath, loadRuntimeState(scopedPath, globalState));
      return;
    }
    applyRuntimeState(globalPath, globalState);
  }

  function inferPattern(ctx: ExtensionContext, tier: string): string[] {
    const raw = state.config.models?.[tier];
    if (raw && (!Array.isArray(raw) || raw.length > 0)) {
      return scopedCandidates(ctx, raw).map(modelKey);
    }
    // Unconfigured tiers may derive candidates only from Pi's scoped-model selection.
    // "writing" has no guessTier class; alias to "general" for candidate lookup.
    const inferredTier = tier === "writing" ? "general" : tier;
    const pool = ctx.scopedModels && ctx.scopedModels.length > 0
      ? ctx.scopedModels.map(({ model }) => model)
      : ctx.modelRegistry.getAvailable();
    return pool
      .filter((model) => guessTier(model, state.config.tierHeuristics) === inferredTier)
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
    jevEffort?: number,
  ) {
    const thinkingConfig = state.config.thinking;
    const rawDecision = assessThinking({
      text: prompt,
      turnDepth: thinkingSession.turnDepth(prompt),
      lastTurnFailed: thinkingSession.getLastTurnOutcome().failed,
      lastTurnErrored: thinkingSession.getLastTurnOutcome().errored,
      jevEffort,
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
    level = capThinkingLevel(level, reasons, {
      free: model !== undefined && billingClass(model) === "free",
      maxLevel: thinkingConfig?.maxLevel ?? "high",
      tier: selectedTier,
      tierCap: thinkingConfig?.byTier?.[selectedTier],
    });
    const clamp = clampToModel(level, model ?? {});
    if (clamp.reason) reasons.push(clamp.reason);
    const readableReasons = reasons.map((reason) => reason.replace(/^[+-]\d+\s+/, "").replaceAll("-", " "));
    return {
      level: clamp.level,
      score: decision.score,
      reasons,
      summary: `score ${decision.score}: ${readableReasons.join(", ")}`,
    };
  }

  state.previewThinking = (prompt, selectedTier, model, jevEffort) => {
    if (state.thinkingPinned) {
      return { level: state.thinkingLevel, mode: "pinned", summary: "manual thinking level is pinned" };
    }
    if (state.thinkingMode === "off") {
      return { level: state.thinkingLevel, mode: "off", summary: "automatic thinking selection is disabled" };
    }
    const decision = decideThinking(prompt, selectedTier, model, true, jevEffort);
    return { level: decision.level, mode: state.thinkingMode, summary: decision.summary };
  };

  const handleCommand = createCommandRouter(state);

  if (typeof pi.events?.on === "function" && typeof pi.events.emit === "function") {
    pi.events.on("bifrost:rpc:v1:request", async (raw) => {
      const result = await handleRpcRequest(raw, async (text) => {
      if (!activeContext || !state.enabled) return null;

      const classification = await getPipeline(activeContext).classify(text);
      if (classification.kind !== "classified") return null;

      const tier = classification.tier;
      const pattern = inferPattern(activeContext, tier);
      const strategy = getStrategy(state.config.categoryStrategies, state.config.strategy, tier);
      const defaultTier = state.config.default;
      const resolved = resolveModelWithFallback(activeContext, {
        requestedTier: tier,
        requestedPattern: pattern,
        requestedStrategy: strategy,
        defaultTier,
        defaultPattern: defaultTier ? inferPattern(activeContext, defaultTier) : undefined,
        defaultStrategy: defaultTier
          ? getStrategy(state.config.categoryStrategies, state.config.strategy, defaultTier)
          : strategy,
        reliabilityState: state.reliabilityStore.getState(),
        reliabilityConfig: state.config.reliability,
        quota: quotaStore.getSnapshot(),
        quotaConfig: state.config.quotaRouting,
        requestedCandidates: diagnoseCandidates(activeContext, pattern).candidates,
        strict: isStrictCategory(state.config, tier),
      });
      if (!resolved.selected) return null;

      const selectedTier = resolved.selectedTier ?? tier;
      const thinking = state.previewThinking?.(text, selectedTier, resolved.selected, classification.jevEffort) ?? { level: "off" };
      return {
        model: modelKey(resolved.selected),
        thinking: { level: thinking.level },
      };
      });

      if (result.requestId && result.reply) {
        pi.events.emit(`bifrost:rpc:v1:reply:${result.requestId}`, result.reply);
      }
    });

    // Cross-extension signal: remote-pi emits this before sendUserMessage so
    // Bifrost can recognise the resulting extension-source input event and
    // route it like a locally-typed prompt.
    pi.events.on("remote-pi:user-prompt", (payload: unknown) => {
      if (
        typeof payload === "object" && payload !== null &&
        typeof (payload as { text?: unknown }).text === "string"
      ) {
        queueRemoteText((payload as { text: string }).text);
      }
    });
  }

  pi.registerCommand("bifrost", {
    description: "Bifrost model router control",
    getArgumentCompletions: getBifrostCommandCompletions,
    handler: async (args, ctx) => {
      await handleCommand(args, ctx);
    },
  });

  // One slash command per configured category: "/coding fix this" forces the
  // coding tier for that prompt. Categories come from bifrost.json "models".
  let commandForcedTier: string | undefined;
  for (const tier of Object.keys(state.config.models ?? {})) {
    if (tier === "bifrost") continue;
    pi.registerCommand(tier, {
      description: `Route this prompt to the Bifrost ${tier} category`,
      handler: async (args, ctx) => {
        const prompt = args.trim();
        if (!prompt) {
          log(ctx, `Usage: /${tier} <prompt>`, "warning");
          return;
        }
        commandForcedTier = tier;
        pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      },
    });
  }

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
    activeContext = ctx;
    loadSessionRuntimeState(ctx.sessionManager?.getSessionId?.());
    state.thinkingLevel = pi.getThinkingLevel();
    lastSeenModel = modelKey(ctx.model);
    setBifrostSilent(ctx, state.silent || isChildSession(ctx));
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
        debug("cache", "warm_start", { entries: state.cacheEntries.length });
      }
    }

    if (!startupValidated && state.enabled) {
      startupValidated = true;
      await state.refreshRegistry(ctx);
      for (const [tier, patterns] of Object.entries(state.config.models ?? {})) {
        const { unresolved } = diagnoseCandidates(ctx, patterns);
        for (const p of unresolved) {
          log(ctx, formatDiagnostic(patternUnresolvable(tier, p)), "warning");
        }
      }
      const classifierPattern = state.config.classifier?.model;
      const classifierPatterns = Array.isArray(classifierPattern)
        ? classifierPattern
        : classifierPattern ? [classifierPattern] : [];
      const hasDirectClassifier = !!state.config.classifier?.endpoint ||
        classifierPatterns.some(isJevModelReference);
      if (classifierPattern && state.classifierEnabled && !hasDirectClassifier) {
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

  pi.on("turn_start", async (event, ctx) => {
    if (!state.enabled || !ctx.model) return;
    // Tools can spend quota between requests; a cached pre-input snapshot is insufficient.
    await quotaStore.refreshIfStale(Date.now(), event.turnIndex > 0);
    const quota = quotaStore.getSnapshot();
    if (!isProviderSessionExhausted(ctx.model, quota, state.config.quotaRouting)
      && !isProviderQuotaExhausted(ctx.model, quota, state.config.quotaRouting)) return;
    const retry = runtimeReliability.getRetryContext();
    const tier = configuredCategory(ctx, ctx.model, state.config.models, retry?.tier ?? state.modelCategory);
    if ((retry?.autoRetryCount ?? 0) >= (state.config.reliability?.maxAutoRetries ?? 2)
      || !completedTools(branch(ctx).flatMap((entry) => "message" in entry ? [entry.message] : []))) {
      ctx.abort();
      pendingHandoff = undefined;
      log(ctx, "Bifrost: exhausted during this run; stopped at the request boundary. Review unfinished work before continuing.", "warning");
      return;
    }
    const next = await switchForHandoff(ctx, ctx.model, tier, !!retry?.images?.length || hasImages(ctx));
    if (!next || !tier) {
      ctx.abort();
      pendingHandoff = undefined;
      log(ctx, "Bifrost: exhausted during this run; no healthy configured/scoped same-category replacement. Stopped without replay.", "warning");
      return;
    }
    runtimeReliability.begin(modelKey(next), { prompt: retry?.prompt ?? "", images: retry?.images, tier, autoRetryCount: (retry?.autoRetryCount ?? 0) + 1 });
    log(ctx, `Bifrost: session exhaustion handoff to ${modelKey(next)} in ${tier}; completed tools preserved.`, "warning");
  });

  pi.on("context", async (event, ctx) => {
    const handoff = pendingHandoff;
    pendingHandoff = undefined;
    if (!handoff || handoff.target !== modelKey(ctx.model)) return;
    return { messages: [...event.messages, { role: "custom" as const, customType: "bifrost-handoff", content: handoff.content, display: false, timestamp: Date.now() }] };
  });

  pi.on("message_end", async (event) => {
    const message = event.message;
    if (!state.enabled || message.role !== "assistant") return;
    // Pi 1.1.0 recognizes billing as terminal before its outer HTTP-429 retry loop.
    if (message.stopReason === "error" && isCreditsRequired(message.errorMessage ?? "")) {
      const terminal = { ...message, errorMessage: `billing exhaustion (credits_required): ${message.errorMessage}` };
      runtimeReliability.observe([terminal]);
      return { message: terminal };
    }
    runtimeReliability.observe([message]);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled) return;
    if (ctx.model && !runtimeReliability.isTracking()) {
      const tier = configuredCategory(ctx, ctx.model, state.config.models, state.modelCategory);
      runtimeReliability.begin(modelKey(ctx.model), tier ? { prompt: event.prompt, images: event.images, tier, autoRetryCount: 0 } : undefined);
    }
    const systemPrompt = frontierSystemPrompt(event.systemPrompt, state.modelCategory);
    return systemPrompt ? { systemPrompt } : undefined;
  });

  pi.on("session_shutdown", async () => {
    pendingHandoff = undefined;
    runtimeReliability.settle();
    cleanupSessionState();
  });

  pi.on("turn_end", async (event) => {
    runtimeReliability.noteToolResults(event.toolResults);
    const failed = event.toolResults.some((result) => result.isError === true);
    const errored = (event.message as { stopReason?: unknown })?.stopReason === "error";
    thinkingSession.noteTurnOutcome(failed, errored);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    setBifrostSilent(ctx, state.silent || isChildSession(ctx));
    const settled = runtimeReliability.settle();
    if (!settled || !state.enabled || state.config.reliability?.enabled === false) return;
    state.reliabilityStore.recordSettled(settled.model, settled.reason);
    if (!settled.reason) return;

    const retry = settled.retry;
    const retryable = isCreditsRequired(settled.reason) || isRetryableProviderLimit(settled.reason) || isRetryableProviderError(settled.reason);
    const max = state.config.reliability?.maxAutoRetries ?? 2;
    // A finalized boundary proves tools finished; never restart the user's prompt.
    const safe = event.outcome !== "aborted" && event.context?.pendingMessages.length === 0
      && !!ctx.sessionManager?.getBranch && completedTools(event.context.contextMessages);
    if (!retryable || !retry || !(state.config.reliability?.autoRetry ?? true) || retry.autoRetryCount >= max || !safe
      || modelKey(ctx.model) !== settled.model || !ctx.model) {
      log(ctx, `Bifrost: provider failure for ${settled.model}; stopped. Review the current branch before continuing; the prompt was not replayed.`, "warning");
      return;
    }
    await quotaStore.refreshIfStale(Date.now());
    const next = await switchForHandoff(ctx, ctx.model, retry.tier, !!retry.images?.length || hasImages(ctx));
    if (!next) {
      log(ctx, `Bifrost: ${settled.model} failed; no healthy configured/scoped same-category handoff could be selected. Stopped without replay.`, "warning");
      return;
    }
    runtimeReliability.begin(modelKey(next), { ...retry, autoRetryCount: retry.autoRetryCount + 1 });
    log(ctx, `Bifrost: continuing on ${modelKey(next)} in ${retry.tier} (${retry.autoRetryCount + 1}/${max}); completed work preserved.`, "warning");
    // Only this fixed marker persists. The Markdown handoff is request-local, in memory.
    return { entries: [{ type: "custom_message" as const, customType: "bifrost-continuation", content: CONTINUATION, display: false }], continue: true };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settled = runtimeReliability.settle();
    if (settled && state.enabled && state.config.reliability?.enabled !== false) {
      state.reliabilityStore.recordSettled(settled.model, settled.reason);
    }
    pendingHandoff = undefined;
    syncBifrostModeStatus(ctx, state);
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
    setBifrostSilent(ctx, state.silent || isChildSession(ctx));
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

    // Subscription guard: redirect OpenRouter models that are available
    // via a subscription provider (e.g. openai/gpt-5.6-sol → openai-codex).
    // Skip the redirect when the subscription provider's quota is exhausted
    // and let the OpenRouter selection stand.
    if (ctx.model && state.config.subscriptionGuard) {
      const redirect = applySubscriptionGuard(ctx.model, state.config.subscriptionGuard);
      if (redirect) {
        const tier = configuredCategory(ctx, ctx.model, state.config.models, state.modelCategory);
        const target = tier ? resolveHealthyModel(ctx, state.config.models?.[tier], "first",
          state.reliabilityStore.getState(), state.config.reliability, Date.now(), quotaStore.getSnapshot(),
          state.config.quotaRouting, scopedCandidates(ctx, redirect).filter((m) => !hasImages(ctx) || supportsImageInput(m)), tier).selected : undefined;
        if (target) {
          const now = Date.now();
          const quota = quotaStore.getSnapshot();
          const weeklyExhausted = isProviderQuotaExhausted(target, quota, state.config.quotaRouting, now);
          const sessionExhausted = isProviderSessionExhausted(target, quota, state.config.quotaRouting, now);
          if (weeklyExhausted || sessionExhausted) {
            debug("bifrost", "subscription_guard_skipped", {
              from: selectedModel, to: redirect,
              reason: weeklyExhausted ? "weekly_exhausted" : "session_exhausted",
            });
            // Let the OpenRouter model stand — don't redirect.
          } else {
            selfSelecting = true;
            let switched = false;
            try { switched = await pi.setModel(target); } catch { /* logged below */ }
            if (switched) {
              log(ctx, `Bifrost: redirected ${selectedModel} \u2192 ${modelKey(target)} (subscription guard)`);
              return;
            }
            selfSelecting = false;
            debug("bifrost", "subscription_guard_failed", { from: selectedModel, to: redirect });
          }
        }
      }
    }

    if (lastRoutedPrompt) {
      const tiers = Object.keys(state.config.models ?? {});
      const escalated = demoteCacheEntry(state.cacheEntries, lastRoutedPrompt, tiers);
      if (escalated) {
        cacheWriter.schedule();
        debug("feedback", "demotion_escalated", { prompt: lastRoutedPrompt.slice(0, 50) });
      }
      lastRoutedPrompt = undefined;
    }

    sessionContext.reset();
    state.pinned = true;
    // Determine which category (quick, general, writing, frontier, coding) the selected model belongs to
    state.modelCategory = ctx.model ? configuredCategory(ctx, ctx.model, state.config.models) : undefined;
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
    activeContext = ctx;
    const isChild = isChildSession(ctx);
    setBifrostSilent(ctx, state.silent || isChild);
    // Safety: clear any guard left unconsumed from the previous turn so it can't wedge.
    // The current turn's thinking_level_select has already been delivered by now.
    selfSettingThinkingLevel = undefined;
    lastSeenModel = modelKey(ctx.model);
    const commandTier = event.source === "extension" ? commandForcedTier : undefined;
    commandForcedTier = undefined;
    if (event.source === "extension" && !commandTier) {
      if (!consumeRemoteText(event.text)) return { action: "continue" };
    }
    clearBifrostWidgets(ctx);
    // Passive subagent observation — logged even when routing is disabled,
    // so child-session model usage stays visible in debug logs.
    if (process.env.PI_SUBAGENT_RUN_ID || isChild) {
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
    // "/frontier debug this" arrives here already stripped, with commandTier set.
    const { forcedTier, promptText } = commandTier
      ? { forcedTier: commandTier, promptText: text }
      : parseInlineOverride(text, state.config.models);
    if (forcedTier) debug("input", "inline_override", { tier: forcedTier });

    // Inline override should strip the tier keyword from what LLM sees.
    const defaultAction = forcedTier
      ? { action: "transform" as const, text: promptText }
      : { action: "continue" as const };

    const now = Date.now();
    await quotaStore.refreshIfStale(now);
    const current = ctx.model;
    const quota = quotaStore.getSnapshot();
    const currentTier = current && configuredCategory(ctx, current, state.config.models, state.modelCategory);
    // An explicit new category is user routing, not an exhaustion retry of the old category.
    if (current && (!forcedTier || forcedTier === currentTier)
      && (isProviderQuotaExhausted(current, quota, state.config.quotaRouting, now)
        || isProviderSessionExhausted(current, quota, state.config.quotaRouting, now))) {
      const tier = currentTier;
      const replacement = await switchForHandoff(ctx, current, tier, !!event.images?.length || hasImages(ctx));
      if (!replacement || !tier) {
        log(ctx, `Bifrost: ${modelKey(current)} exhausted; no safe configured/scoped same-category replacement. Stopped; selection unchanged.`, "warning");
        return { action: "handled" };
      }
      runtimeReliability.begin(modelKey(replacement), { prompt: promptText, images: event.images, tier, autoRetryCount: 0 });
      log(ctx, `Bifrost: ${modelKey(current)} exhausted; handoff to ${modelKey(replacement)} in ${tier}.`, "warning");
      return defaultAction;
    }

    if (state.pinned) {
      if (!forcedTier && !sessionContext.isClearlyUnrelated(promptText)) {
        const tier = ctx.model && configuredCategory(ctx, ctx.model, state.config.models, state.modelCategory);
        if (ctx.model) runtimeReliability.begin(modelKey(ctx.model), tier ? { prompt: promptText, images: event.images, tier, autoRetryCount: 0 } : undefined);
        sessionContext.record(tier ?? state.config.default ?? "general", promptText);
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
        : await getPipeline(ctx).classify(promptText, {
          askTier: ctx.hasUI && !isChild
            ? (tiers) => ctx.ui.select("Bifrost: Jev is unsure. Route this prompt to:", [...tiers])
            : undefined,
        });

      let turnJevEffort: number | undefined;
      if (classification.kind === "classified") {
        turnJevEffort = "jevEffort" in classification ? classification.jevEffort : undefined;
        const tag = classification.source === "inline" ? "!" : classification.source;
        log(ctx, `classify: ${classification.tier} [${tag}]`);
        lastRoutedPrompt = promptText;
      }
      if (classification.kind !== "unclassified") {
        sessionContext.record(classification.tier, promptText);
      }

      await quotaStore.refreshIfStale(Date.now());

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

      let { candidates: requestedCandidates, unresolved } = diagnoseCandidates(ctx, pattern);
      for (const p of unresolved) {
        const warnKey = `${tier}:${p}`;
        if (!warnedPatterns.has(warnKey)) {
          warnedPatterns.add(warnKey);
          log(ctx, formatDiagnostic(patternUnresolvable(tier, p)), "warning");
        }
      }

      const resolveRoute = () => resolveModelWithFallback(ctx, {
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
        strict: isStrictCategory(state.config, tier),
      });
      let resolved = resolveRoute();
      if (resolved.fallbackReason === "requested_tier_unavailable") {
        setBifrostWorkingMessage(ctx, "Bifrost checking models...");
        try {
          resolved = await retryUnavailableResolution(
            resolved,
            () => state.refreshRegistry(ctx),
            () => {
              requestedCandidates = diagnoseCandidates(ctx, pattern).candidates;
              return resolveRoute();
            },
          );
        } finally {
          setBifrostWorkingMessage(ctx, undefined);
        }
      }
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
        tier: selectedTier,
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
        return { action: "handled" };
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
          endCacheSave({ entries: state.cacheEntries.length });
        }
      }

      const applyThinking = () => {
        if (state.thinkingMode === "off" || state.thinkingPinned) return;
        const decision = decideThinking(promptText, selectedTier, model, false, turnJevEffort);
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
        state.modelCategory = selectedTier;
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
        return { action: "handled" };
      }

      applyThinking();
      state.modelCategory = selectedTier;

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
