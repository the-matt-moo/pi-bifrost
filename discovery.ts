import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BifrostConfig, DiscoverySource } from "./config.ts";
import { guessTier, modelKey } from "./routing.ts";

export interface DiscoveryOptions {
  scoped: boolean;
  free: boolean;
}

export interface DiscoveryResult {
  candidates: Model<Api>[];
  sourceModels: Partial<Record<DiscoverySource, Model<Api>[]>>;
  skipped: string[];
  messages: string[];
  unavailableSources: DiscoverySource[];
  duplicateCount: number;
}

export interface DiscoveryDiff {
  config: BifrostConfig;
  added: Array<{ model: string; tier: string }>;
  removed: Array<{ model: string; tier: string }>;
}

const SOURCE_ORDER: readonly DiscoverySource[] = ["scoped", "free"];

export function parseDiscoveryOptions(args: string): DiscoveryOptions {
  const flags = new Set(args.trim().split(/\s+/).filter(Boolean));
  return { scoped: flags.has("--scoped"), free: flags.has("--free") };
}

function isOpenRouterModel(ctx: ExtensionContext, model: Model<Api>): boolean {
  const displayName = ctx.modelRegistry.getProviderDisplayName(model.provider);
  let host = "";
  try {
    host = new URL(model.baseUrl).hostname;
  } catch {
    // Provider display metadata remains the fallback.
  }
  return /open\s*router/i.test(displayName) || host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function isFreeModel(model: Model<Api>): boolean {
  const rates = [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite];
  const tiers = model.cost.tiers?.flatMap((tier) => [tier.input, tier.output, tier.cacheRead, tier.cacheWrite]) ?? [];
  return [...rates, ...tiers].every((rate) => rate === 0);
}

export function discoverModels(
  ctx: ExtensionContext,
  options: DiscoveryOptions,
  excludedScopedModelKeys: ReadonlySet<string> = new Set(),
): DiscoveryResult {
  const available = [...ctx.modelRegistry.getAvailable()].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
  const availableByKey = new Map(available.map((model) => [modelKey(model), model]));
  const sourceModels: Partial<Record<DiscoverySource, Model<Api>[]>> = {};
  const skipped: string[] = [];
  const messages: string[] = [];
  const unavailableSources: DiscoverySource[] = [];

  if (options.scoped) {
    if (ctx.scopedModels.length === 0) {
      messages.push("No scoped-model selection is configured. Set enabledModels or launch Pi with --models, then retry.");
      unavailableSources.push("scoped");
      sourceModels.scoped = [];
    } else {
      sourceModels.scoped = ctx.scopedModels
        .map(({ model }) => {
          const current = availableByKey.get(modelKey(model));
          if (!current) skipped.push(`${modelKey(model)} (scoped model unavailable after registry refresh)`);
          return current;
        })
        .filter((model): model is Model<Api> => model !== undefined)
        .filter((model) => !excludedScopedModelKeys.has(modelKey(model)))
        .sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
    }
  }

  if (options.free) {
    const allModels = ctx.modelRegistry.getAll();
    const openRouterCatalog = allModels.filter((model) => isOpenRouterModel(ctx, model));
    const openRouterAvailable = available.filter((model) => isOpenRouterModel(ctx, model));
    sourceModels.free = openRouterAvailable.filter(isFreeModel);

    if (openRouterCatalog.length === 0) {
      messages.push("OpenRouter is not present in Pi's model registry.");
      unavailableSources.push("free");
    } else if (openRouterAvailable.length === 0) {
      messages.push("OpenRouter is unavailable or not configured; no free-tier models can be discovered.");
      unavailableSources.push("free");
    } else if (sourceModels.free.length === 0) {
      messages.push("OpenRouter is configured, but its current registry catalog contains no free-tier models.");
    }
  }

  const union = new Map<string, Model<Api>>();
  let sourceCount = 0;
  for (const source of SOURCE_ORDER) {
    for (const model of sourceModels[source] ?? []) {
      sourceCount++;
      union.set(modelKey(model), model);
    }
  }

  return {
    candidates: [...union.values()].sort((a, b) => modelKey(a).localeCompare(modelKey(b))),
    sourceModels,
    skipped: skipped.sort(),
    messages,
    unavailableSources,
    duplicateCount: sourceCount - union.size,
  };
}

function modelLists(config: BifrostConfig): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(config.models ?? {}).map(([tier, value]) => [tier, Array.isArray(value) ? [...value] : [value]]),
  );
}

function sortedManaged(managed: Record<string, DiscoverySource[]>): Record<string, DiscoverySource[]> {
  return Object.fromEntries(
    Object.entries(managed)
      .filter(([, sources]) => sources.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, sources]) => [key, SOURCE_ORDER.filter((source) => sources.includes(source))]),
  );
}

export function buildDiscoveryMetadata(
  sourceModels: DiscoveryResult["sourceModels"],
  includedKeys: ReadonlySet<string>,
): NonNullable<BifrostConfig["discovery"]> {
  const managed: Record<string, DiscoverySource[]> = {};
  for (const source of SOURCE_ORDER) {
    for (const model of sourceModels[source] ?? []) {
      const key = modelKey(model);
      if (includedKeys.has(key)) (managed[key] ??= []).push(source);
    }
  }
  return { managed: sortedManaged(managed) };
}

export function reconcileDiscoveredModels(
  config: BifrostConfig,
  discovery: DiscoveryResult,
  selected: DiscoveryOptions,
  verifiedKeys: ReadonlySet<string>,
): DiscoveryDiff {
  const models = modelLists(config);
  const originalTier = new Map<string, string>();
  for (const [tier, keys] of Object.entries(models)) {
    for (const key of keys) if (!originalTier.has(key)) originalTier.set(key, tier);
  }

  const managed: Record<string, DiscoverySource[]> = Object.fromEntries(
    Object.entries(config.discovery?.managed ?? {}).map(([key, sources]) => [key, [...sources]]),
  );
  const selectedSources = SOURCE_ORDER.filter((source) => selected[source]);
  const currentBySource = Object.fromEntries(
    selectedSources.map((source) => [source, new Set((discovery.sourceModels[source] ?? []).map(modelKey))]),
  ) as Partial<Record<DiscoverySource, Set<string>>>;

  for (const [key, sources] of Object.entries(managed)) {
    managed[key] = sources.filter((source) => !selected[source] || currentBySource[source]?.has(key));
  }
  for (const source of selectedSources) {
    for (const key of currentBySource[source] ?? []) {
      if (managed[key]) managed[key] = [...new Set([...managed[key], source])];
    }
  }

  const removed: DiscoveryDiff["removed"] = [];
  for (const [key, sources] of Object.entries(managed)) {
    if (sources.length > 0) continue;
    for (const [tier, keys] of Object.entries(models)) {
      if (!keys.includes(key)) continue;
      models[tier] = keys.filter((candidate) => candidate !== key);
      removed.push({ model: key, tier });
    }
    delete managed[key];
  }

  const candidatesByKey = new Map(discovery.candidates.map((model) => [modelKey(model), model]));
  const added: DiscoveryDiff["added"] = [];
  for (const key of [...verifiedKeys].sort()) {
    const model = candidatesByKey.get(key);
    if (!model) continue;
    const sources = selectedSources.filter((source) => currentBySource[source]?.has(key));

    if (originalTier.has(key)) {
      if (managed[key]) managed[key] = [...new Set([...managed[key], ...sources])];
      continue;
    }

    const tier = guessTier(model);
    (models[tier] ??= []).push(key);
    originalTier.set(key, tier);
    managed[key] = sources;
    added.push({ model: key, tier });
  }

  for (const keys of Object.values(models)) {
    const seen = new Set<string>();
    keys.splice(0, keys.length, ...keys.filter((key) => !seen.has(key) && seen.add(key)));
  }

  return {
    config: {
      ...config,
      models,
      discovery: { managed: sortedManaged(managed) },
    },
    added: added.sort((a, b) => a.model.localeCompare(b.model)),
    removed: removed.sort((a, b) => a.model.localeCompare(b.model)),
  };
}
