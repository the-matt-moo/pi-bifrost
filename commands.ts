import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadRuntimeState, runtimeStatePath } from "./runtime-state.ts";
import type { BifrostConfig } from "./config.ts";
import type { ThinkingLevel } from "./thinking.ts";
import { DEFAULT_RULES, loadConfig, readJson } from "./config.ts";
import type { CacheEntry } from "./cache.ts";
import { cachePath, loadCache, DEFAULT_MAX_ENTRIES, DEFAULT_THRESHOLD } from "./cache.ts";
import type { ClassificationPipeline } from "./classification-pipeline.ts";
import { setupDebug, debug, debugMeasure } from "./debug.ts";
import { runProbe, PROBE_PROMPT_TEXT, type ProbeResult } from "./probe.ts";
import {
  buildDiscoveryMetadata,
  discoverModels,
  parseDiscoveryOptions,
  reconcileDiscoveredModels,
  type DiscoveryOptions,
  type DiscoveryResult,
} from "./discovery.ts";
import { setBifrostModeStatus, setBifrostStatus } from "./ux-status.ts";
import { showBifrostResult } from "./result-viewer.ts";
import {
  getStrategy,
  guessTier,
  modelKey,
  resolveModelWithFallback,
  diagnoseCandidates,
  type HealthyModelResolution,
  type RoutingStrategy,
} from "./routing.ts";
import { fetchFreeModelRanking, capFreeModels, sortTierModels, FREE_MODEL_LIMIT } from "./collection-ranking.ts";
import type { ReliabilityStore } from "./reliability-store.ts";
import {
  formatDiagnostic,
  patternUnresolvable,
  classifierModelMissing,
  type BifrostDiagnostic,
} from "./diagnostics.ts";

// ── Mutable state shared across commands ────────────────────

export interface BifrostState {
  config: BifrostConfig;
  enabled: boolean;
  classifierEnabled: boolean;
  thinkingMode: "off" | "advisory" | "apply";
  thinkingPinned: boolean;
  thinkingLevel: ThinkingLevel;
  lastThinkingDecision?: { score: number; level: ThinkingLevel; reasons: string[] };
  previewThinking?: (
    prompt: string,
    selectedTier: string,
    model: Model<Api> | undefined,
  ) => { level: ThinkingLevel; mode: string; summary: string };
  pinned: boolean;
  silent: boolean;
  cacheEntries: CacheEntry[];
  reliabilityStore: ReliabilityStore;
  extensionDir: string;
  getPipeline: (ctx: ExtensionContext) => ClassificationPipeline;
  invalidatePipeline: () => void;
  /** Persist runtime mode toggles (enabled/classifierEnabled/silent) to disk. */
  saveModeState: () => void;
  lastRegistryRefreshAt?: number;
  forceRegistryRefresh?: boolean;
  registryRefreshInflight?: Promise<boolean>;
  refreshRegistry: (ctx: ExtensionContext) => Promise<boolean>;
  scheduleCacheSave: () => void;
  flushCacheSave: () => Promise<void>;
}

const silentContexts = new WeakSet<ExtensionContext>();

export function setBifrostSilent(ctx: ExtensionContext, silent: boolean): void {
  if (silent) silentContexts.add(ctx);
  else silentContexts.delete(ctx);
}

function isBifrostSilent(ctx: ExtensionContext): boolean {
  return silentContexts.has(ctx);
}

let overwriteActive = false;

export function logOverwrite(
  ctx: ExtensionContext,
  message: string,
): void {
  if (isBifrostSilent(ctx)) return;
  if (ctx.mode === "tui") {
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage(message);
      ctx.ui.setWorkingVisible(true);
    }
    return;
  }
  process.stderr.write(`\r\x1b[2K[bifrost] ${message}`);
  overwriteActive = true;
}

export function finalizeOverwrite(): void {
  if (overwriteActive) {
    process.stderr.write("\n");
    overwriteActive = false;
  }
}

export function log(
  ctx: ExtensionContext,
  message: string,
  type?: "info" | "warning" | "error",
  force = false
) {
  if (!force && isBifrostSilent(ctx)) return;
  finalizeOverwrite();
  if (ctx.mode !== "tui") {
    console.error(`[bifrost] ${message}`);
  }
  if (ctx.hasUI) ctx.ui.notify(message, type ?? "info");
}

// Rainbow letters mirror the status-line `bifrost` word.
const BIFROST_RAINBOW = ["255;0;0", "255;127;0", "255;255;0", "0;255;0", "65;105;255", "105;65;165", "180;70;225"];
const TIER_COLORS: Record<string, string> = {
  quick: "\x1b[32m",        // green
  general: "\x1b[36m",      // cyan
  frontier: "\x1b[38;5;208m", // orange
};

const HOT_PINK = "\x1b[38;2;255;105;180m"; // pinned category slot

function rainbowWord(word: string): string {
  return [...word]
    .map((ch, i) => `\x1b[38;2;${BIFROST_RAINBOW[i % BIFROST_RAINBOW.length]}m${ch}`)
    .join("") + "\x1b[0m";
}

/** `Bifrost: <category> → <model> (suffix)` with rainbow word, white arrow, violet model. When `pinned`, the category slot shows `pinned` in hot pink. */
export function formatBifrostRouting(tier: string, model: string, suffix = "", pinned = false): string {
  const category = pinned
    ? `${HOT_PINK}pinned\x1b[0m`
    : `${TIER_COLORS[tier] ?? "\x1b[0m"}${tier}\x1b[0m`;
  const arrow = "\x1b[37m→\x1b[0m";
  const tail = suffix ? ` \x1b[90m(${suffix})\x1b[0m` : "";
  return `${rainbowWord("Bifrost")}: ${category} ${arrow} \x1b[38;2;180;70;225m${model}\x1b[0m${tail}`;
}

export function uiBusy(ctx: ExtensionContext, message: string) {
  if (isBifrostSilent(ctx)) return;
  finalizeOverwrite();
  if (ctx.mode === "tui") {
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage(message);
      ctx.ui.setWorkingVisible(true);
    }
  } else {
    console.error(`[bifrost] ${message}`);
  }
}

export function uiDone(ctx: ExtensionContext) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWorkingMessage(undefined);
  }
}

function uiOutput(ctx: ExtensionContext, lines: string[]) {
  if (isBifrostSilent(ctx)) return;
  finalizeOverwrite();
  if (ctx.mode === "tui") {
    if (ctx.hasUI) {
      ctx.ui.setWidget("bifrost-output", lines);
    }
  } else {
    for (const line of lines) console.error(`[bifrost] ${line}`);
  }
}

async function uiResult(ctx: ExtensionContext, title: string, lines: string[]): Promise<void> {
  if (isBifrostSilent(ctx)) return;
  finalizeOverwrite();
  if (await showBifrostResult(ctx, title, lines)) return;
  if (ctx.mode !== "tui") {
    for (const line of lines) console.error(`[bifrost] ${line}`);
  }
}

export function clearBifrostWidgets(ctx: ExtensionContext) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWidget("bifrost-output", []);
    ctx.ui.setWidget("bifrost-probe", []);
  }
}

export function syncBifrostModeStatus(ctx: ExtensionContext, state: Pick<BifrostState, "enabled" | "pinned" | "classifierEnabled" | "silent" | "thinkingMode" | "thinkingPinned">) {
  setBifrostModeStatus(ctx, { ...state, modelCategory: ctx.model ? guessTier(ctx.model) : undefined });
}

function openCircuitCount(state: BifrostState, now = Date.now()): number {
  return state.reliabilityStore.openCircuitCount(now);
}

/** Feed probe results into the reliability store as circuit-breaker outcomes. */
function applyProbeOutcomes(state: BifrostState, results: ProbeResult[]): void {
  state.reliabilityStore.applyOutcomes(
    results.map((r) =>
      r.status === "ok"
        ? { model: `${r.provider}/${r.model}`, ok: true as const, source: "probe" }
        : { model: `${r.provider}/${r.model}`, ok: false as const, source: "probe", reason: r.error ?? r.status }
    ),
    Date.now(),
  );
}

function formatCandidateLines(
  resolution: HealthyModelResolution,
  selectedKey: string | undefined,
): string[] {
  const skipped = new Map(resolution.skipped.map((item) => [item.key, item]));
  return resolution.candidates.map((m) => {
    const key = modelKey(m);
    const skippedCandidate = skipped.get(key);
    if (skippedCandidate) {
      const until = skippedCandidate.openUntil
        ? new Date(skippedCandidate.openUntil).toISOString()
        : "unknown";
      return `xx ${key} (open circuit until ${until})`;
    }
    const marker = key === selectedKey ? "=>" : "  ";
    return `${marker} ${key} ($${(m.cost.input + m.cost.output).toFixed(2)}/1M tokens, ctx ${m.contextWindow})`;
  });
}

// ── Shared tier-resolution + display ───────────────────────

function resolveTierDisplay(
  tier: string,
  state: BifrostState,
  ctx: ExtensionContext,
) {
  const pattern = state.config.models?.[tier] ?? tier;
  const strategy = getStrategy(state.config.categoryStrategies, state.config.strategy, tier);
  const defaultTier = state.config.default;
  const defaultPattern = defaultTier ? (state.config.models?.[defaultTier] ?? defaultTier) : undefined;
  const defaultStrategy = defaultTier
    ? getStrategy(state.config.categoryStrategies, state.config.strategy, defaultTier)
    : strategy;

  const resolved = resolveModelWithFallback(ctx, {
    requestedTier: tier,
    requestedPattern: pattern,
    requestedStrategy: strategy,
    defaultTier,
    defaultPattern,
    defaultStrategy,
    reliabilityState: state.reliabilityStore.getState(),
    reliabilityConfig: state.config.reliability,
  });

  const selectedKey = resolved.selected ? modelKey(resolved.selected) : undefined;
  const requestedCandidateLines = formatCandidateLines(
    resolved.primary,
    resolved.selectedTier === tier ? selectedKey : undefined,
  );
  const fallbackCandidateLines = resolved.fallback
    ? formatCandidateLines(
        resolved.fallback,
        resolved.selectedTier && resolved.selectedTier !== tier ? selectedKey : undefined,
      )
    : [];

  return {
    strategy,
    selected: selectedKey ?? "none",
    selectedModel: resolved.selected,
    selectedTier: resolved.selectedTier ?? "none",
    fallbackReason: resolved.fallbackReason,
    requestedCandidateLines,
    fallbackCandidateLines,
    defaultTier,
  };
}

// ── Init proposal builder (exported for tests) ──────────────

/** Default strategy per tier when generating init proposals. */
const PROPOSAL_STRATEGIES: Record<string, RoutingStrategy> = {
  quick: "first",
  general: "first",
  frontier: "first",
  economical: "cheapest",
};

export function buildInitProposal(
  models: Record<string, string[]>,
  classifierModel: string,
  extensionDir: string,
  discovery?: BifrostConfig["discovery"],
): Record<string, unknown> {
  const tierKeys = Object.keys(models);
  // Pick the first populated tier as default, or fall back to first key.
  const defaultTier = tierKeys.length > 0 ? tierKeys[0] : "general";
  const categoryStrategies: Record<string, RoutingStrategy> = {};
  for (const t of tierKeys) {
    categoryStrategies[t] = PROPOSAL_STRATEGIES[t] ?? "first";
  }
  return {
    $schema: `${extensionDir.replace(/\/$/, "")}/schema.json`,
    enabled: true,
    default: defaultTier,
    strategy: "first" as RoutingStrategy,
    categoryStrategies,
    classifier: {
      enabled: true,
      model: classifierModel,
      method: "auto" as const,
    },
    models,
    rules: DEFAULT_RULES,
    ...(discovery ? { discovery } : {}),
  };
}

// ── Discovery helpers ───────────────────────────────────────

function usesDiscovery(options: DiscoveryOptions): boolean {
  return options.scoped || options.free;
}

function discoverySourceLine(discovery: DiscoveryResult): string {
  const scoped = discovery.sourceModels.scoped?.length ?? 0;
  const free = discovery.sourceModels.free?.length ?? 0;
  return `scoped=${scoped}, free=${free}, deduplicated=${discovery.duplicateCount}`;
}

async function refreshAndDiscover(
  ctx: ExtensionContext,
  state: BifrostState,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  uiBusy(ctx, "Refreshing Pi model registry...");
  const refreshed = await state.refreshRegistry(ctx);
  if (!refreshed) {
    log(ctx, "Model registry refresh failed; using current snapshot.", "warning");
  }
  uiDone(ctx);

  const discovery = discoverModels(ctx, options);
  for (const message of discovery.messages) log(ctx, message, "warning");
  log(ctx, `Discovery sources: ${discoverySourceLine(discovery)}.`);
  for (const item of discovery.skipped) log(ctx, `Skipped: ${item}.`, "warning");
  return discovery;
}

function writeAndReloadConfig(config: BifrostConfig, state: BifrostState): void {
  const dir = join(process.cwd(), CONFIG_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bifrost.json"), JSON.stringify(config, null, 2));

  state.config = loadConfig(process.cwd(), state.extensionDir);
  const runtimeState = loadRuntimeState(runtimeStatePath(process.cwd()), {
    enabled: state.config.enabled ?? true,
    pinned: false,
    classifierEnabled: state.config.classifier?.enabled ?? true,
    thinkingMode: state.config.thinking?.mode ?? "off",
    silent: state.config.silent ?? false,
  });
  state.enabled = runtimeState.enabled;
  state.pinned = runtimeState.pinned;
  state.classifierEnabled = runtimeState.classifierEnabled;
  state.thinkingMode = runtimeState.thinkingMode ?? "off";
  state.silent = runtimeState.silent;
  state.reliabilityStore.reload(state.config.reliability, process.cwd());
  state.invalidatePipeline();
}

// ── Command handlers ────────────────────────────────────────

async function handleInit(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  clearBifrostWidgets(ctx);

  const discoveryOptions = parseDiscoveryOptions(args);
  const forceProbe = args.trim().split(/\s+/).includes("--force");
  const discoveryEnabled = usesDiscovery(discoveryOptions);
  const discovery = discoveryEnabled
    ? await refreshAndDiscover(ctx, state, discoveryOptions)
    : undefined;
  const selectedModels = discovery?.candidates;

  if (discoveryEnabled && selectedModels?.length === 0) {
    log(ctx, "Discovery returned no candidates; config not changed.", "error");
    return;
  }

  let workingModels: { provider: string; model: string; cost: { input: number; output: number }; duration_ms: number }[] = [];
  let probeLoaded = false;
  let probeAge = "";

  const collectionRankingPromise = discoveryOptions.free ? fetchFreeModelRanking() : Promise.resolve(null);

  // Probe runner reuses fresh successes and retests stale/failed models.
  if (!probeLoaded) {
    const available = selectedModels ?? ctx.modelRegistry.getAvailable();
    const availableCount = available.length;
    log(ctx, `Probing ${availableCount} discovered model(s) to find working ones...`);
    let okCount = 0;
    let errCount = 0;
    const lastModels: string[] = [];

    uiBusy(ctx, `Probing ${availableCount} models...`);
    const { results, freshResults, cached } = await runProbe(ctx, (done, total, last) => {
      if (last.status === "ok") okCount++;
      // models parameter passed below
      else if (last.status === "error" || last.status === "timeout") errCount++;
      lastModels.push(`${last.provider}/${last.model}: ${last.status} (${last.duration_ms}ms)`);
      if (lastModels.length > 5) lastModels.shift();

      if (ctx.hasUI) {
        ctx.ui.setWidget("bifrost-probe", [
          `Probing models: ${done}/${total}`,
          `  ok: ${okCount}  errors: ${errCount}`,
          "",
          ...lastModels,
        ]);
      }
    }, available, { force: forceProbe });
    uiDone(ctx);
    applyProbeOutcomes(state, freshResults);

    workingModels = results
      .filter((r) => r.status === "ok")
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        cost: { input: r.cost_input ?? 0, output: r.cost_output ?? 0 },
        duration_ms: r.duration_ms ?? 0,
      }));
    probeLoaded = true;
    probeAge = cached === results.length ? "cached" : (cached > 0 ? `${cached} cached` : "just now");

    const ok = results.filter((r) => r.status === "ok").length;
    const errors = results.filter((r) => r.status === "error").length;
    const timeouts = results.filter((r) => r.status === "timeout").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    log(ctx, `Probe complete: ok=${ok} error=${errors} timeout=${timeouts} skipped=${skipped}.`);
    if (ok === 0) {
      log(ctx, "No usable models found. Check API keys, network, and credits.", "error");
      if (discoveryEnabled) {
        log(ctx, "Discovery init stopped; config not changed.", "warning");
        return;
      }
      log(ctx, "Proceeding with full registry — most models will likely be unreachable.", "warning");
      probeLoaded = false;
    }
  }

  if (probeLoaded && workingModels.length > 0) {
    log(ctx, `Using ${workingModels.length} probe-verified models (${probeAge}).`);
  }

  let available = selectedModels ?? ctx.modelRegistry.getAvailable();
  const durationByKey = new Map(workingModels.map((w) => [`${w.provider}/${w.model}`, w.duration_ms]));

  const collectionRanking = await collectionRankingPromise;
  if (discoveryOptions.free && discovery?.sourceModels.free) {
    const originalFree = discovery.sourceModels.free;
    const originalFreeKeys = new Set(originalFree.map((m) => `${m.provider}/${m.id}`));
    const verifiedKeys = new Set(workingModels.map((w) => `${w.provider}/${w.model}`));
    discovery.sourceModels.free = capFreeModels(
      originalFree,
      (m) => `${m.provider}/${m.id}`,
      verifiedKeys,
      collectionRanking,
      durationByKey,
    );
    const keptFreeKeys = new Set(discovery.sourceModels.free.map((m) => `${m.provider}/${m.id}`));
    available = available.filter((m) => {
      const key = `${m.provider}/${m.id}`;
      return !originalFreeKeys.has(key) || keptFreeKeys.has(key);
    });
    if (collectionRanking) {
      log(ctx, `Imported top ${discovery.sourceModels.free.length} free model(s) by collection ranking.`);
    } else {
      log(ctx, `Collection ranking unavailable; capped to ${FREE_MODEL_LIMIT} fastest free models.`, "warning");
    }
  }

  const models: Record<string, string[]> = {};

  for (const m of available) {
    const key = `${m.provider}/${m.id}`;

    // If probe data is loaded, skip models that failed or timed out.
    if (probeLoaded && workingModels.length > 0) {
      const working = workingModels.find(
        (w) => w.provider === m.provider && w.model === m.id,
      );
      if (!working) continue; // known-broken, silently skip
    }

    const tier = guessTier(m);
    models[tier] = models[tier] ?? [];
    models[tier].push(key);
  }

  // Order every tier: non-free by probe duration, then free by collection rank.
  const freeKeys = new Set((discovery?.sourceModels.free ?? []).map((m) => `${m.provider}/${m.id}`));
  for (const tier of Object.keys(models)) {
    sortTierModels(models[tier], collectionRanking, freeKeys, durationByKey);
  }

  // Pick a classifier default: fastest cheap working model.
  let classifierModel: string | undefined;
  if (probeLoaded && workingModels.length > 0) {
    const cheapWorking = workingModels
      .filter((w) => (w.cost.input + w.cost.output) < 2)
      .sort((a, b) => a.duration_ms - b.duration_ms);
    if (cheapWorking.length > 0) {
      classifierModel = `${cheapWorking[0].provider}/${cheapWorking[0].model}`;
    }
  }
  if (!classifierModel) {
    // Fallback: any working model, or a sensible default.
    if (workingModels.length > 0) {
      classifierModel = `${workingModels[0].provider}/${workingModels[0].model}`;
    } else {
      classifierModel = "opencode/mimo-v2.5-free";
      log(ctx, "No working models found for classifier. Using default — it may not work.", "warning");
    }
  }

  const includedKeys = new Set(Object.values(models).flat());
  const discoveryMetadata = discovery
    ? buildDiscoveryMetadata(discovery.sourceModels, includedKeys)
    : undefined;
  const proposal = buildInitProposal(models, classifierModel, state.extensionDir, discoveryMetadata);

  const totalAssigned = Object.values(models).reduce((s, v) => s + v.length, 0);

  const probeErrors = probeLoaded
    ? workingModels.length < available.length
      ? available
          .filter((m) => !workingModels.some((w) => w.provider === m.provider && w.model === m.id))
          .map((m) => `${m.provider}/${m.id}`)
      : []
    : [];

  const summaryLines: string[] = [
    "--- init summary ---",
    `source: ${probeLoaded ? `probe (${workingModels.length} working)` : `registry (${available.length} listed)`}`,
    ...(discovery ? [`discovery: ${discoverySourceLine(discovery)}`] : []),
    "",
  ];
  for (const [tier, tierModels] of Object.entries(models)) {
    summaryLines.push(`[${tier}] (${tierModels.length} model${tierModels.length === 1 ? "" : "s"})`);
    for (const key of tierModels) summaryLines.push(`  ${key}`);
  }
  summaryLines.push("", `classifier: ${classifierModel}`);
  if (discovery?.skipped.length) {
    summaryLines.push("", "skipped (discovery):");
    for (const item of discovery.skipped) summaryLines.push(`  ${item}`);
  }
  if (probeErrors.length > 0) {
    summaryLines.push("", `errors (${probeErrors.length} model${probeErrors.length === 1 ? "" : "s"} failed probe):`);
    for (const key of probeErrors) summaryLines.push(`  ${key}`);
  }
  if (!probeLoaded) summaryLines.push("", "warning: no probe data — run /bifrost probe first to filter unreachable models");
  summaryLines.push("--------------------");

  uiOutput(ctx, summaryLines);

  const writeWithoutPrompt = args.trim().split(/\s+/).includes("--write");
  if (!ctx.hasUI && !writeWithoutPrompt) {
    log(ctx, "run in TUI or use --write to persist", "warning");
    return;
  }

  const confirmBody = [
    `${totalAssigned} model${totalAssigned === 1 ? "" : "s"} across ${Object.keys(models).length} tier${Object.keys(models).length === 1 ? "" : "s"}`,
    probeErrors.length > 0 ? `${probeErrors.length} model${probeErrors.length === 1 ? "" : "s"} failed probe` : "",
  ].filter(Boolean).join(". ");

  const ok = writeWithoutPrompt || await ctx.ui.confirm(
    "Write config to .pi/bifrost.json?",
    `${confirmBody}.`,
  );
  if (!ok) {
    log(ctx, "config not written");
    return;
  }

  writeAndReloadConfig(proposal as BifrostConfig, state);

  log(ctx, "wrote .pi/bifrost.json and reloaded config");
  log(ctx, `Bifrost active with ${Object.keys(state.config.models ?? {}).length} tier(s). Try a prompt.`);

  // Clear the init widget so it doesn't persist in the TUI.
  if (ctx.hasUI) {
    ctx.ui.setWidget("bifrost-output", []);
    ctx.ui.setWidget("bifrost-probe", []);
  }
}

async function handleUpdate(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  await handleDiscoveryReconcile(args, ctx, state, "update", false);
}

async function handleRefresh(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  await handleDiscoveryReconcile(args, ctx, state, "refresh", true);
}

async function handleDiscoveryReconcile(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
  verb: "update" | "refresh",
  forceScoped: boolean,
): Promise<void> {
  clearBifrostWidgets(ctx);
  const parsed = parseDiscoveryOptions(args);
  const forceProbe = args.trim().split(/\s+/).includes("--force");
  const requested = forceScoped ? { scoped: true, free: parsed.free } : parsed;
  if (!usesDiscovery(requested)) {
    log(ctx, `usage: /bifrost ${verb} --scoped [--free] [--force] [--write]`, "warning");
    return;
  }

  const discovery = await refreshAndDiscover(ctx, state, requested);
  const selected: DiscoveryOptions = {
    scoped: requested.scoped,
    free: requested.free && !discovery.unavailableSources.includes("free"),
  };
  if (!usesDiscovery(selected)) {
    log(ctx, "No requested discovery source is available; config not changed.", "error");
    return;
  }

  const updateRankingPromise = selected.free ? fetchFreeModelRanking() : Promise.resolve(null);

  uiBusy(ctx, `Probing ${discovery.candidates.length} discovered model(s)...`);
  const { results, freshResults } = await runProbe(ctx, undefined, discovery.candidates, { force: forceProbe });
  uiDone(ctx);
  applyProbeOutcomes(state, freshResults);

  const verifiedKeys = new Set(
    results.filter((result) => result.status === "ok").map((result) => `${result.provider}/${result.model}`),
  );
  const durationByKey = new Map(results.map((r) => [`${r.provider}/${r.model}`, r.duration_ms]));

  const updateRanking = await updateRankingPromise;
  if (selected.free && discovery.sourceModels.free) {
    const originalFree = discovery.sourceModels.free;
    const originalFreeKeys = new Set(originalFree.map((m) => `${m.provider}/${m.id}`));
    discovery.sourceModels.free = capFreeModels(
      originalFree,
      (m) => `${m.provider}/${m.id}`,
      verifiedKeys,
      updateRanking,
      durationByKey,
    );
    const keptFreeKeys = new Set(discovery.sourceModels.free.map((m) => `${m.provider}/${m.id}`));
    discovery.candidates = discovery.candidates.filter((m) => {
      const key = `${m.provider}/${m.id}`;
      return !originalFreeKeys.has(key) || keptFreeKeys.has(key);
    });
  }

  const configPath = join(process.cwd(), CONFIG_DIR_NAME, "bifrost.json");
  const current = readJson<BifrostConfig>(configPath) ?? state.config;
  
  const diff = reconcileDiscoveredModels(current, discovery, selected, verifiedKeys);

  // Order every tier: non-free by probe duration, then free by collection rank.
  const freeKeys = new Set((discovery.sourceModels.free ?? []).map((m) => `${m.provider}/${m.id}`));
  for (const tierModels of Object.values(diff.config.models ?? {})) {
    if (Array.isArray(tierModels)) sortTierModels(tierModels, updateRanking, freeKeys, durationByKey);
  }

  const probeSkipped = results
    .filter((result) => result.status !== "ok")
    .map((result) => `${result.provider}/${result.model} (${result.status}${result.error ? `: ${result.error}` : ""})`)
    .sort();

  uiOutput(ctx, [
    `--- ${verb} ---`,
    `discovery: ${discoverySourceLine(discovery)}`,
    `probe: ${verifiedKeys.size} working, ${probeSkipped.length} skipped`,
    ...discovery.skipped.map((item) => `skipped discovery: ${item}`),
    ...probeSkipped.map((item) => `skipped probe: ${item}`),
    "add:",
    ...(diff.added.length > 0 ? diff.added.map((item) => `  + ${item.model} -> ${item.tier}`) : ["  (none)"]),
    "remove:",
    ...(diff.removed.length > 0 ? diff.removed.map((item) => `  - ${item.model} <- ${item.tier}`) : ["  (none)"]),
    "proposed config:",
    JSON.stringify(diff.config, null, 2),
    "--------------",
  ]);

  const writeWithoutPrompt = args.trim().split(/\s+/).includes("--write");
  if (!ctx.hasUI && !writeWithoutPrompt) {
    log(ctx, "run in TUI or use --write to persist", "warning");
    return;
  }
  const confirmLines = [`Add ${diff.added.length} and remove ${diff.removed.length} discovery-managed model(s)?`];
  if (diff.added.length > 0) {
    confirmLines.push("", "Added:", ...diff.added.map((item) => `  + ${item.model} -> ${item.tier}`));
  }
  if (diff.removed.length > 0) {
    confirmLines.push("", "Removed:", ...diff.removed.map((item) => `  - ${item.model} <- ${item.tier}`));
  }

  const ok = writeWithoutPrompt || await ctx.ui.confirm(
    "Write config update?",
    confirmLines.join("\n"),
  );
  if (!ok) {
    log(ctx, "config not written");
    return;
  }

  writeAndReloadConfig(diff.config, state);
  log(ctx, `Updated .pi/bifrost.json: +${diff.added.length} -${diff.removed.length}.`);
}

async function handleBenchmark(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const prompt =
    args.slice("benchmark".length).trim() ||
    "Write a short Python function to reverse a string and explain it briefly.";
  const categories = Object.keys(state.config.models ?? {});

  if (categories.length === 0) {
    log(ctx, "no categories configured; run /bifrost init first", "warning");
    return;
  }

  clearBifrostWidgets(ctx);
  setBifrostStatus(ctx, "benchmarking prompt...", "accent");
  uiBusy(ctx, "Classifying benchmark prompt...");
  let classification;
  try {
    classification = await state.getPipeline(ctx).classify(prompt);
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
  const tier = classification.kind !== "unclassified" ? classification.tier : undefined;
  const source = classification.kind === "classified" ? classification.source : "fallback";

  const lines = [
    "--- benchmark ---",
    `prompt: ${prompt}`,
    `tier: ${tier ?? "none"}`,
    `source: ${source}`,
    "per-tier selection:",
  ];

  for (const tierName of categories) {
    const display = resolveTierDisplay(tierName, state, ctx);
    lines.push(`  ${tierName} (${display.strategy} → ${display.selectedTier}):`);
    if (display.fallbackReason) lines.push(`    fallback: ${display.fallbackReason}`);
    lines.push(...display.requestedCandidateLines.map((line) => `    ${line}`));
    if (display.fallbackCandidateLines.length > 0 && display.defaultTier && display.defaultTier !== tierName) {
      lines.push(`    fallback candidates (${display.defaultTier}):`);
      lines.push(...display.fallbackCandidateLines.map((line) => `    ${line}`));
    }
  }

  lines.push("-----------------");
  await uiResult(ctx, "Bifrost benchmark", lines);
}

async function handleSync(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  clearBifrostWidgets(ctx);
  const dryRun = args.includes("--dry-run");
  const githubPath = process.env.GITHUB_PATH ?? join(process.env.USERPROFILE ?? "", "Github");
  const profileDir = join(githubPath, "pi-profile");
  const scriptPath = join(profileDir, "scripts", "sync-bifrost.ps1");

  if (!existsSync(scriptPath)) {
    log(ctx, `Sync script not found: ${scriptPath} (set GITHUB_PATH to override)`, "error");
    return;
  }

  setBifrostStatus(ctx, "Syncing bifrost config to pi-profile...", "accent");
  uiBusy(ctx, "Running sync-bifrost.ps1...");

  const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(dryRun ? ["-DryRun"] : [])], {
      cwd: profileDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });

  uiDone(ctx);
  syncBifrostModeStatus(ctx, state);

  if (exitCode !== 0) {
    log(ctx, `Sync failed (exit ${exitCode}): ${stderr.slice(0, 500)}`, "error");
    return;
  }

  if (stdout.trim()) {
    uiOutput(ctx, stdout.trim().split("\n"));
  }
  log(ctx, dryRun ? "Dry-run complete — no changes written" : "Sync complete");
}

async function handlePreview(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const prompt = args.slice("preview".length).trim();
  if (!prompt) {
    log(ctx, "usage: /bifrost preview <prompt>", "warning");
    return;
  }

  clearBifrostWidgets(ctx);
  setBifrostStatus(ctx, "previewing prompt...", "accent");
  uiBusy(ctx, "Classifying preview prompt...");
  let classification;
  try {
    classification = await state.getPipeline(ctx).classify(prompt);
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
  if (classification.kind === "unclassified") {
    log(ctx, "no tier matched", "warning");
    return;
  }
  const tier = classification.tier;
  const source = classification.kind === "classified" ? classification.source : "fallback";
  const display = resolveTierDisplay(tier, state, ctx);
  const thinking = state.previewThinking?.(prompt, display.selectedTier, display.selectedModel) ?? {
    level: state.thinkingLevel,
    mode: state.thinkingMode,
    summary: state.thinkingPinned ? "manual thinking level is pinned" : "thinking preview unavailable",
  };
  const selection = display.selectedTier !== tier
    ? `${source} chose ${tier}; ${display.fallbackReason ?? "fallback"} selected ${display.selected} from ${display.selectedTier}`
    : `${source} chose ${tier}; ${display.strategy} selected ${display.selected}`;

  const lines = [
    "--- preview ---",
    `prompt:    ${prompt}`,
    `source:    ${source}`,
    `tier:      ${tier}`,
    `strategy:  ${display.strategy}`,
    `selected tier: ${display.selectedTier}`,
    ...(display.fallbackReason ? [`fallback:  ${display.fallbackReason}`] : []),
    `requested candidates (${tier}):`,
    ...display.requestedCandidateLines,
  ];
  if (display.fallbackCandidateLines.length > 0 && display.defaultTier && display.defaultTier !== tier) {
    lines.push(`fallback candidates (${display.defaultTier}):`);
    lines.push(...display.fallbackCandidateLines);
  }
  lines.push(`selected:  ${display.selected}`);
  lines.push(`thinking:  ${thinking.level} (${thinking.mode})`);
  lines.push(`why model: ${selection}`);
  lines.push(`why thinking: ${thinking.summary}`);
  lines.push("---------------");

  await uiResult(ctx, "Bifrost preview", lines);
}

async function handleAddModel(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  clearBifrostWidgets(ctx);

  const rawInput = args.slice("add-model".length).trim();
  let key = rawInput;
  let model = undefined as ReturnType<typeof ctx.modelRegistry.getAll>[number] | undefined;
  const allModels = ctx.modelRegistry.getAll();
  const lower = rawInput.toLowerCase();

  if (rawInput.includes("/")) {
    const [provider, ...idParts] = rawInput.split("/");
    const id = idParts.join("/");
    model = ctx.modelRegistry.find(provider, id) ?? allModels.find((m) => modelKey(m).toLowerCase() === rawInput.toLowerCase());
  } else if (rawInput) {
    const exactMatches = allModels.filter((m) => m.id.toLowerCase() === lower);
    if (exactMatches.length === 1) {
      model = exactMatches[0];
      key = modelKey(model);
    } else {
      const similarMatches = allModels.filter((m) => {
        const k = modelKey(m).toLowerCase();
        return k.includes(lower) || m.id.toLowerCase().includes(lower) || m.provider.toLowerCase().includes(lower);
      });
      if (similarMatches.length === 1) {
        model = similarMatches[0];
        key = modelKey(model);
      } else if (ctx.hasUI && similarMatches.length > 1) {
        const picked = await ctx.ui.select(
          `Clarify model "${rawInput}"`,
          similarMatches.map((m) => modelKey(m)),
        );
        if (!picked) {
          log(ctx, "Cancelled");
          return;
        }
        model = similarMatches.find((m) => modelKey(m) === picked);
        if (model) key = modelKey(model);
      }
    }
  }

  if (!model) {
    if (!ctx.hasUI) {
      log(ctx, "Usage: /bifrost add-model <provider/model>", "warning");
      return;
    }
    const picked = await ctx.ui.input("Enter full provider/model key:");
    if (!picked) {
      log(ctx, "Cancelled");
      return;
    }
    const normalized = picked.trim();
    const [provider, ...idParts] = normalized.split("/");
    const id = idParts.join("/");
    model = normalized.includes("/") ? ctx.modelRegistry.find(provider, id) : undefined;
    if (!model) {
      log(ctx, `Couldn't resolve "${normalized}". Please use provider/model.`, "warning");
      return;
    }
    key = modelKey(model);
  }

  uiBusy(ctx, `Probing ${key}...`);
  try {
    const { results } = await runProbe(ctx, undefined, [model], { force: true });
    const probe = results[0];
    if (!probe || probe.status !== "ok") {
      log(ctx, `Model "${key}" must pass probe before adding${probe?.error ? `: ${probe.error}` : ` (status: ${probe?.status ?? "unknown"})`}.`, "error");
      return;
    }
  } finally {
    uiDone(ctx);
  }

  // Add to settings.json (enabledModels)
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const settings = readJson<{ enabledModels?: string[] }>(settingsPath);
      if (settings) {
        settings.enabledModels = settings.enabledModels ?? [];
        if (!settings.enabledModels.includes(key)) {
          settings.enabledModels.push(key);
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          log(ctx, `Added "${key}" to enabledModels in settings.json`);
        } else {
          log(ctx, `"${key}" is already in enabledModels in settings.json`);
        }
      }
    }
  } catch (err) {
    log(ctx, `Failed to update settings.json: ${err}`, "warning");
  }

  // Add to active bifrost.json
  const configPath = join(process.cwd(), CONFIG_DIR_NAME, "bifrost.json");
  const current = readJson<BifrostConfig>(configPath) ?? state.config;

  const categories = Object.keys(current.models ?? {});
  if (categories.length === 0) {
    log(ctx, "No categories found in bifrost config; add categories first", "error");
    return;
  }

  const selectedCategories = new Set<string>();
  if (ctx.hasUI) {
    while (true) {
      const menuOptions = categories.map((cat) => {
        const checked = selectedCategories.has(cat) ? "[x]" : "[ ]";
        return `${checked} ${cat}`;
      });
      menuOptions.push("[Done]");
      const choice = await ctx.ui.select(
        `Select categories to place "${key}" in (chosen: ${selectedCategories.size}):`,
        menuOptions,
      );
      if (!choice || choice === "[Done]") {
        break;
      }
      const catName = choice.slice(4);
      if (selectedCategories.has(catName)) {
        selectedCategories.delete(catName);
      } else {
        selectedCategories.add(catName);
      }
    }
  } else {
    // If not in TUI/UI, choose the default category
    const defCat = current.default ?? "general";
    if (categories.includes(defCat)) {
      selectedCategories.add(defCat);
      log(ctx, `Non-interactive mode: placing model in default category "${defCat}"`);
    } else if (categories.length > 0) {
      selectedCategories.add(categories[0]);
      log(ctx, `Non-interactive mode: placing model in category "${categories[0]}"`);
    }
  }

  if (selectedCategories.size === 0) {
    log(ctx, "Operation cancelled: no categories selected");
    return;
  }

  current.models = current.models ?? {};
  for (const cat of selectedCategories) {
    const list = current.models[cat];
    if (Array.isArray(list)) {
      if (!list.includes(key)) {
        list.push(key);
      }
    } else if (typeof list === "string") {
      current.models[cat] = [list, key];
    } else {
      current.models[cat] = [key];
    }
  }

  // Mark as scoped model
  current.discovery = current.discovery ?? { managed: {} };
  current.discovery.managed = current.discovery.managed ?? {};
  const managedSources = current.discovery.managed[key] ?? [];
  if (!managedSources.includes("scoped")) {
    current.discovery.managed[key] = [...managedSources, "scoped"];
  }

  // Write and reload config
  writeAndReloadConfig(current, state);
  log(ctx, `Updated bifrost.json categories for "${key}"`);

  // Also update agent-level override bifrost.json
  const agentBifrostPath = join(getAgentDir(), "bifrost.json");
  if (existsSync(agentBifrostPath)) {
    const agentCurrent = readJson<BifrostConfig>(agentBifrostPath) ?? {};
    let agentUpdated = false;

    // Add to categories
    agentCurrent.models = agentCurrent.models ?? {};
    for (const cat of selectedCategories) {
      const list = agentCurrent.models[cat];
      if (Array.isArray(list)) {
        if (!list.includes(key)) {
          list.push(key);
          agentUpdated = true;
        }
      } else if (typeof list === "string") {
        if (list !== key) {
          agentCurrent.models[cat] = [list, key];
          agentUpdated = true;
        }
      } else {
        agentCurrent.models[cat] = [key];
        agentUpdated = true;
      }
    }

    // Mark as scoped in discovery
    agentCurrent.discovery = agentCurrent.discovery ?? { managed: {} };
    agentCurrent.discovery.managed = agentCurrent.discovery.managed ?? {};
    const agentManagedSources = agentCurrent.discovery.managed[key] ?? [];
    if (!agentManagedSources.includes("scoped")) {
      agentCurrent.discovery.managed[key] = [...agentManagedSources, "scoped"];
      agentUpdated = true;
    }

    if (agentUpdated) {
      writeFileSync(agentBifrostPath, JSON.stringify(agentCurrent, null, 2));
      log(ctx, `Also added "${key}" to agent-level bifrost.json categories: ${[...selectedCategories].join(", ")}`);
    }
  }

  // Run registry refresh
  uiBusy(ctx, "Refreshing registry...");
  try {
    state.forceRegistryRefresh = true;
    await state.refreshRegistry(ctx);
  } catch (err) {
    log(ctx, `Registry refresh failed: ${err}`, "warning");
  }
  uiDone(ctx);

  log(ctx, `Successfully added "${key}" to categories: ${[...selectedCategories].join(", ")}`);
}

async function handleRemoveModel(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  clearBifrostWidgets(ctx);

  let rawInput = args.slice("remove-model".length).trim();
  if (!rawInput) {
    if (!ctx.hasUI) {
      log(ctx, "Usage: /bifrost remove-model <provider/model>", "warning");
      return;
    }
    const picked = await ctx.ui.input("Enter full provider/model key to remove:");
    if (!picked) {
      log(ctx, "Cancelled");
      return;
    }
    rawInput = picked.trim();
  }

  // Resolve to exact model key
  const allModels = ctx.modelRegistry.getAll();
  let model = allModels.find((m) => modelKey(m).toLowerCase() === rawInput.toLowerCase());
  if (!model) {
    log(ctx, `Model "${rawInput}" not found in registry.`, "error");
    return;
  }
  const key = modelKey(model);

  // Check if model is in scoped models (enabledModels)
  const settingsPath = join(getAgentDir(), "settings.json");
  let wasInEnabledModels = false;
  if (existsSync(settingsPath)) {
    const settings = readJson<{ enabledModels?: string[] }>(settingsPath);
    if (settings?.enabledModels?.includes(key)) {
      wasInEnabledModels = true;
      settings.enabledModels = settings.enabledModels.filter((k) => k !== key);
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      log(ctx, `Removed "${key}" from enabledModels in settings.json`);
    }
  }

  // Check if model is in bifrost.json (models and discovery.managed)
  const configPath = join(process.cwd(), CONFIG_DIR_NAME, "bifrost.json");
  const current = readJson<BifrostConfig>(configPath) ?? state.config;

  let wasInBifrost = false;
  let removedFromCategories: string[] = [];
  const models = current.models ?? {};
  for (const [cat, modelList] of Object.entries(models)) {
    const list = Array.isArray(modelList) ? modelList : [modelList];
    const idx = list.indexOf(key);
    if (idx >= 0) {
      wasInBifrost = true;
      list.splice(idx, 1);
      current.models![cat] = list.length === 1 ? list[0] : list;
      removedFromCategories.push(cat);
    }
  }

  // Remove from discovery.managed
  if (current.discovery?.managed?.[key]) {
    wasInBifrost = true;
    delete current.discovery.managed[key];
  }

  if (!wasInEnabledModels && !wasInBifrost) {
    log(ctx, `Model "${key}" is not currently scoped or used by Bifrost.`, "error");
    return;
  }

  // Check and remove from agent-level override bifrost.json
  const agentBifrostPath = join(getAgentDir(), "bifrost.json");
  let wasInAgentBifrost = false;
  let removedFromAgentCategories: string[] = [];
  if (existsSync(agentBifrostPath)) {
    const agentCurrent = readJson<BifrostConfig>(agentBifrostPath) ?? {};
    const agentModels = agentCurrent.models ?? {};
    for (const [cat, modelList] of Object.entries(agentModels)) {
      const list = Array.isArray(modelList) ? modelList : [modelList];
      const idx = list.indexOf(key);
      if (idx >= 0) {
        wasInAgentBifrost = true;
        list.splice(idx, 1);
        agentModels![cat] = list.length === 1 ? list[0] : list;
        removedFromAgentCategories.push(cat);
      }
    }

    // Remove from discovery.managed in agent config
    if (agentCurrent.discovery?.managed?.[key]) {
      wasInAgentBifrost = true;
      delete agentCurrent.discovery.managed[key];
    }

    if (wasInAgentBifrost) {
      writeFileSync(agentBifrostPath, JSON.stringify(agentCurrent, null, 2));
      log(ctx, `Removed "${key}" from agent-level bifrost.json categories: ${removedFromAgentCategories.join(", ") ?? "(none)"}`);
    }
  }

  // Write and reload config
  writeAndReloadConfig(current, state);
  log(ctx, `Updated bifrost.json: removed "${key}" from categories: ${removedFromCategories.join(", ") ?? "(none)"}`);
  if (removedFromAgentCategories.length > 0) {
    log(ctx, `Also removed "${key}" from agent-level bifrost.json: ${removedFromAgentCategories.join(", ") ?? "(none)"}`);
  }

  // Run registry refresh
  uiBusy(ctx, "Refreshing registry...");
  try {
    state.forceRegistryRefresh = true;
    await state.refreshRegistry(ctx);
  } catch (err) {
    log(ctx, `Registry refresh failed: ${err}`, "warning");
  }
  uiDone(ctx);

  log(ctx, `Successfully removed "${key}" from Bifrost config`);
}

// ── Command type ────────────────────────────────────────────

type CommandFn = (args: string, ctx: ExtensionContext) => void | Promise<void>;

interface CommandSpec {
  readonly value: string;
  readonly description: string;
  readonly argumentHint?: string;
}

interface CommandEntry extends CommandSpec {
  readonly match: (sub: string) => boolean;
  readonly handler: CommandFn;
}

function exact(word: string, description: string, handler: CommandFn): CommandEntry {
  return { value: word, description, match: (sub) => sub === word, handler };
}

function prefix(word: string, description: string, handler: CommandFn, argumentHint = "<prompt>"): CommandEntry {
  return { value: word, description, argumentHint, match: (sub) => sub.startsWith(word), handler };
}

export const BIFROST_COMMAND_OPTIONS: readonly CommandSpec[] = [
  { value: "on", description: "Enable routing" },
  { value: "off", description: "Disable routing" },
  { value: "pin", description: "Lock current model" },
  { value: "unpin", description: "Resume routing" },
  { value: "silence", description: "Hide Bifrost output" },
  { value: "unsilence", description: "Show Bifrost output" },
  { value: "reload", description: "Reload config after editing" },
  { value: "providers", description: "List available providers" },
  { value: "probe", description: "Probe models (optional --scoped, --free, or --force)" },
  { value: "init", description: "Generate config (optional --scoped, --free, or --force)" },
  { value: "update", description: "Reconcile discovery-managed models", argumentHint: "--scoped [--free] [--force]" },
  { value: "refresh", description: "Add new scoped models without recategorizing existing", argumentHint: "[--free] [--force]" },
  { value: "sync", description: "Sync live bifrost.json to pi-profile repo", argumentHint: "[--dry-run]" },
  { value: "benchmark", description: "Classify a benchmark prompt", argumentHint: "<prompt>" },
  { value: "cache stats", description: "Show classification cache" },
  { value: "cache clear", description: "Clear classification cache" },
  { value: "classifier on", description: "Enable LLM classifier" },
  { value: "classifier off", description: "Disable LLM classifier" },
  { value: "classifier status", description: "Show classifier state" },
  { value: "thinking", description: "Show or set thinking mode", argumentHint: "[off|advisory|apply|status]" },
  { value: "debug", description: "Show config and routing state" },
  { value: "doctor", description: "Validate config against available models" },
  { value: "preview", description: "Preview routing for a prompt", argumentHint: "<prompt>" },
  { value: "add-model", description: "Add model to scoped list and categories", argumentHint: "[<model-key>]" },
  { value: "remove-model", description: "Remove model from scoped list and configs", argumentHint: "<model-key>" },
] as const;

export function getBifrostCommandCompletions(prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  const items = BIFROST_COMMAND_OPTIONS.filter((command) => command.value.startsWith(normalized)).map((command) => ({
    value: command.value,
    label: command.value,
    description: command.description,
  }));
  return items.length > 0 ? items : null;
}

function formatBifrostCommandChoice(command: CommandSpec): string {
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return `/bifrost ${command.value}${hint} — ${command.description}`;
}

function dashboardCommands(state: Pick<BifrostState, "enabled" | "pinned" | "silent">): CommandSpec[] {
  const values = [
    state.enabled ? "off" : "on",
    state.pinned ? "unpin" : "pin",
    state.silent ? "unsilence" : "silence",
    "preview",
    "thinking",
    "providers",
    "probe",
    "init",
    "refresh",
    "add-model",
    "remove-model",
    "classifier status",
    "reload",
  ];
  return values.map((value) => BIFROST_COMMAND_OPTIONS.find((command) => command.value === value)!);
}

async function pickBifrostCommand(
  ctx: ExtensionContext,
  title = "Bifrost commands",
  options: readonly CommandSpec[] = BIFROST_COMMAND_OPTIONS,
): Promise<CommandSpec | undefined> {
  if (!ctx.hasUI) return undefined;
  const selected = await ctx.ui.select(title, options.map(formatBifrostCommandChoice));
  if (!selected) return undefined;
  return options.find((command) => formatBifrostCommandChoice(command) === selected);
}

// ── Route table ─────────────────────────────────────────────

export function createCommandRouter(
  state: BifrostState,
): (args: string, ctx: ExtensionContext) => Promise<void> {
  const routes: CommandEntry[] = [
    exact("on", "Enable routing", (_, ctx) => {
      state.enabled = true;
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost enabled");
    }),
    exact("off", "Disable routing", (_, ctx) => {
      state.enabled = false;
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost disabled");
    }),
    exact("pin", "Lock current model", (_, ctx) => {
      state.pinned = true;
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost pinned");
    }),
    exact("unpin", "Resume routing", (_, ctx) => {
      state.pinned = false;
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost unpinned");
    }),
    exact("silence", "Hide Bifrost output", (_, ctx) => {
      state.silent = true;
      state.saveModeState();
      setBifrostSilent(ctx, true);
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
    }),
    exact("unsilence", "Show Bifrost output", (_, ctx) => {
      state.silent = false;
      state.saveModeState();
      setBifrostSilent(ctx, false);
      syncBifrostModeStatus(ctx, state);
      log(ctx, "Bifrost output enabled");
    }),
    exact("reload", "Reload config after editing", async (_, ctx) => {
      const done = debugMeasure("command", "reload");
      await state.flushCacheSave();
      state.config = loadConfig(process.cwd(), state.extensionDir);
      // Re-init debug — user may have updated debug config since startup.
      setupDebug(state.config.debug ?? { enabled: false }, process.cwd());
      const runtimeState = loadRuntimeState(runtimeStatePath(process.cwd()), {
        enabled: state.config.enabled ?? true,
        pinned: false,
        classifierEnabled: state.config.classifier?.enabled ?? true,
        thinkingMode: state.config.thinking?.mode ?? "off",
        silent: state.config.silent ?? false,
      });
      state.enabled = runtimeState.enabled;
      state.classifierEnabled = runtimeState.classifierEnabled;
      state.thinkingMode = runtimeState.thinkingMode ?? "off";
      state.pinned = runtimeState.pinned;
      state.silent = runtimeState.silent;
      setBifrostSilent(ctx, state.silent);
      state.cacheEntries = loadCache(cachePath(process.cwd(), state.config.cache?.path));
      state.reliabilityStore.reload(state.config.reliability, process.cwd());
      state.invalidatePipeline();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      done();
      debug("command", "reloaded", {
        enabled: state.enabled,
        classifierEnabled: state.classifierEnabled,
        tiers: Object.keys(state.config.models ?? {}).join(","),
      });
      log(ctx, "Bifrost config reloaded");
    }),

    // Providers
    exact("providers", "List available providers", (_, ctx) => {
      uiBusy(ctx, "Loading providers...");
      const available = ctx.modelRegistry.getAvailable();
      const counts = new Map<string, number>();
      for (const m of available) {
        counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
      }
      uiDone(ctx);
      uiOutput(ctx, [
        "available providers:",
        ...Array.from(counts.entries()).map(
          ([provider, count]) => `  ${provider}: ${count} model(s)`,
        ),
      ]);
    }),

    // Probe — test every model with a tiny prompt
    {
      value: "probe",
      description: "Probe models (optional --scoped, --free, or --force)",
      match: (sub) => sub === "probe" || sub.startsWith("probe "),
      handler: async (args, ctx) => {
        const options = parseDiscoveryOptions(args);
        const forceProbe = args.trim().split(/\s+/).includes("--force");
        const discovery = usesDiscovery(options)
          ? await refreshAndDiscover(ctx, state, options)
          : undefined;
        const available = discovery?.candidates ?? ctx.modelRegistry.getAvailable();
        if (available.length === 0) {
          log(ctx, "No models available for selected discovery sources.", "warning");
          return;
        }
        clearBifrostWidgets(ctx);
        uiBusy(ctx, `Probing ${available.length} models...`);
        log(ctx, `Probing ${available.length} model(s) with "${PROBE_PROMPT_TEXT}"...`);

        const { results, freshResults, path, cached } = await runProbe(
          ctx,
          undefined,
          discovery ? available : undefined,
          { force: forceProbe },
        );
        uiDone(ctx);
        applyProbeOutcomes(state, freshResults);

        const ok = results.filter((r) => r.status === "ok");
        const errs = results.filter((r) => r.status === "error");
        const timeouts = results.filter((r) => r.status === "timeout");
        const skipped = results.filter((r) => r.status === "skipped");

        const lines = [
          `--- probe results (${results.length} models, ${cached} cached) ---`,
          `  ok:      ${ok.length}`,
          `  error:   ${errs.length}`,
          `  timeout: ${timeouts.length}`,
          `  skipped: ${skipped.length}`,
          "",
        ];

        if (errs.length > 0) {
          lines.push("errors:");
          for (const e of errs.slice(0, 10)) {
            lines.push(`  ${e.provider}/${e.model} — ${e.error}`);
          }
          if (errs.length > 10) lines.push(`  ... and ${errs.length - 10} more`);
        }

        if (timeouts.length > 0) {
          lines.push("timeouts:");
          for (const t of timeouts) {
            lines.push(`  ${t.provider}/${t.model}`);
          }
        }

        lines.push("", `full results → ${path}`);
        uiOutput(ctx, lines);

        if (ok.length < results.length) {
          log(
            ctx,
            `${ok.length}/${results.length} models responded. Check ${path} for details.`,
            "warning",
          );
        } else if (ok.length > 0) {
          log(ctx, `All ${ok.length} models responded successfully.`);
        }

        // Clear the probe widget so results don't persist in the TUI.
        if (ctx.hasUI) {
          ctx.ui.setWidget("bifrost-probe", []);
          ctx.ui.setWidget("bifrost-output", []);
        }
        },
    },

    // Init
    {
      value: "init",
      description: "Probe models and generate config",
      match: (sub) => sub === "init" || sub.startsWith("init "),
      handler: (args, ctx) => handleInit(args, ctx, state),
    },
    {
      value: "update",
      description: "Reconcile discovery-managed models",
      match: (sub) => sub === "update" || sub.startsWith("update "),
      handler: (args, ctx) => handleUpdate(args, ctx, state),
    },
    {
      value: "refresh",
      description: "Add new scoped models without recategorizing existing",
      match: (sub) => sub === "refresh" || sub.startsWith("refresh "),
      handler: (args, ctx) => handleRefresh(args, ctx, state),
    },
    {
      value: "sync",
      description: "Sync live bifrost.json to pi-profile repo",
      match: (sub) => sub === "sync" || sub.startsWith("sync "),
      handler: (args, ctx) => handleSync(args, ctx, state),
    },

    // Benchmark
    prefix("benchmark", "Classify a benchmark prompt", (args, ctx) => handleBenchmark(args, ctx, state), "<prompt>"),

    // Cache
    exact("cache stats", "Show classification cache", (_, ctx) => {
      log(
        ctx,
        `cache: ${state.cacheEntries.length} entries (cap ${state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES}, threshold ${state.config.cache?.threshold ?? DEFAULT_THRESHOLD})`,
      );
    }),
    exact("cache clear", "Clear classification cache", (_, ctx) => {
      state.cacheEntries = [];
      state.scheduleCacheSave();
      state.invalidatePipeline();
      log(ctx, "cache cleared");
    }),

    // Classifier
    exact("classifier on", "Enable LLM classifier", (_, ctx) => {
      state.classifierEnabled = true;
      state.saveModeState();
      state.invalidatePipeline();
      syncBifrostModeStatus(ctx, state);
      debug("command", "classifier_toggle", { enabled: true });
      log(ctx, "LLM classifier enabled");
    }),
    exact("classifier off", "Disable LLM classifier", (_, ctx) => {
      state.classifierEnabled = false;
      state.saveModeState();
      state.invalidatePipeline();
      syncBifrostModeStatus(ctx, state);
      debug("command", "classifier_toggle", { enabled: false });
      log(ctx, "LLM classifier disabled; regex fallback active");
    }),
    {
      value: "thinking",
      description: "Show or set thinking mode",
      match: (sub) => sub === "thinking" || sub.startsWith("thinking "),
      handler: (args, ctx) => {
        const mode = args.replace(/^thinking\b/i, "").trim().toLowerCase();
        if (!mode || mode === "status") {
          const decision = state.lastThinkingDecision;
          log(ctx, `thinking: mode=${state.thinkingMode} level=${state.thinkingLevel} pinned=${state.thinkingPinned}${decision ? ` last=${decision.level} score=${decision.score} reasons=${decision.reasons.join(",")}` : ""}`, "info", true);
          return;
        }
        if (mode !== "off" && mode !== "advisory" && mode !== "apply") {
          log(ctx, "Usage: /bifrost thinking [off|advisory|apply|status]", "warning", true);
          return;
        }
        state.thinkingMode = mode as any;
        state.saveModeState();
        syncBifrostModeStatus(ctx, state);
        log(ctx, `thinking mode set to ${mode}`, "info", true);
      },
    },
    exact("classifier status", "Show classifier state", (_, ctx) => {
      const rawModel = state.config.classifier?.model;
      const modelId = Array.isArray(rawModel)
        ? rawModel.join(", ")
        : (rawModel ?? "none");
      log(
        ctx,
        `classifier: enabled=${state.classifierEnabled} model=${modelId} endpoint=${state.config.classifier?.endpoint ?? "registry"} method=${state.config.classifier?.method ?? "auto"}`,
      );
    }),

    // Debug — show loaded config state
    exact("debug", "Show config and routing state", (_, ctx) => {
      const rules = state.config.rules ?? [];
      const tiers = Object.keys(state.config.models ?? {});
      const lines = [
        "--- config ---",
        `cwd: ${process.cwd()}`,
        `enabled: ${state.enabled}`,
        `pinned: ${state.pinned}`,
        `classifierEnabled: ${state.classifierEnabled}`,
        `silent: ${state.silent}`,
        `default: ${state.config.default}`,
        `strategy: ${state.config.strategy}`,
        `tiers: ${tiers.join(", ")}`,
        `debug: ${JSON.stringify(state.config.debug)}`,
        `cache: ${state.cacheEntries.length} entries`,
        `reliability: ${JSON.stringify(state.config.reliability ?? {})}`,
        `openCircuits: ${openCircuitCount(state)}`,
        "",
        `rules (${rules.length}):`,
        ...rules.map((r, i) => `  ${i}: "${r.pattern}" → "${r.model}"`),
        "---",
      ];
      uiOutput(ctx, lines);
      log(ctx, "debug info printed above");
    }),

    exact("doctor", "Validate config against available models", async (_, ctx) => {
      clearBifrostWidgets(ctx);
      uiBusy(ctx, "Running diagnostics...");

      const diagnostics: BifrostDiagnostic[] = [];

      for (const [tier, patterns] of Object.entries(state.config.models ?? {})) {
        const { unresolved } = diagnoseCandidates(ctx, patterns);
        for (const p of unresolved) {
          diagnostics.push(patternUnresolvable(tier, p));
        }
      }

      const classifierPattern = state.config.classifier?.model;
      if (classifierPattern && state.classifierEnabled) {
        const classified = diagnoseCandidates(ctx, classifierPattern);
        if (classified.candidates.length === 0) {
          const patternStr = Array.isArray(classifierPattern) ? classifierPattern[0] : classifierPattern;
          diagnostics.push(classifierModelMissing(patternStr));
        }
      }

      uiDone(ctx);

      if (diagnostics.length === 0) {
        log(ctx, "All model patterns resolve correctly. No issues found.");
        return;
      }

      const lines = [
        `--- doctor (${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"}) ---`,
        ...diagnostics.map(d => `  [${d.severity}] ${formatDiagnostic(d)}`),
        "---",
      ];
      uiOutput(ctx, lines);
    }),

    prefix("preview", "Preview routing for a prompt", (args, ctx) => handlePreview(args, ctx, state), "<prompt>"),
    prefix("add-model", "Add model to scoped list and categories", (args, ctx) => handleAddModel(args, ctx, state), "[<model-key>]"),
    prefix("remove-model", "Remove model from scoped list and configs", (args, ctx) => handleRemoveModel(args, ctx, state), "<model-key>"),
  ];

  return async (args: string, ctx: ExtensionContext) => {
    setBifrostSilent(ctx, state.silent);
    const trimmed = args.trim();
    const sub = trimmed.toLowerCase();

    if (!trimmed) {
      debug("command", "dashboard");
      if (!ctx.hasUI) {
        log(
          ctx,
          `Bifrost: enabled=${state.enabled} pinned=${state.pinned} current=${modelKey(ctx.model)}`,
        );
        return;
      }

      const mode = !state.enabled ? "off" : state.pinned ? "pinned" : "on";
      const selected = await pickBifrostCommand(
        ctx,
        `Bifrost · ${mode} · model ${modelKey(ctx.model)}${openCircuitCount(state) > 0 ? ` · circuits ${openCircuitCount(state)} open` : ""}`,
        dashboardCommands(state),
      );
      if (!selected) return;

      if (selected.argumentHint) {
        ctx.ui.setEditorText(`/bifrost ${selected.value} `);
        log(ctx, `Prefilled /bifrost ${selected.value}. Usage: /bifrost ${selected.value} ${selected.argumentHint}`);
        return;
      }

      const route = routes.find((entry) => entry.value === selected.value);
      if (!route) return;
      await route.handler(route.value, ctx);
      return;
    }

    for (const route of routes) {
      if (route.match(sub)) {
        debug("command", "dispatch", { command: sub });
        await route.handler(trimmed, ctx);
        return;
      }
    }

    debug("command", "picker", { command: sub });
    if (!ctx.hasUI) {
      log(ctx, `Unknown /bifrost subcommand: ${trimmed}`, "warning", true);
      return;
    }

    const selected = await pickBifrostCommand(ctx);
    if (!selected) return;

    if (selected.argumentHint) {
      ctx.ui.setEditorText(`/bifrost ${selected.value} `);
      log(ctx, `Prefilled /bifrost ${selected.value}`);
      return;
    }

    const route = routes.find((entry) => entry.value === selected.value);
    if (!route) return;

    debug("command", "dispatch", { command: route.value });
    await route.handler(route.value, ctx);
  };
}
