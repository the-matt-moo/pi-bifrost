import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getCircuitState, type ReliabilityConfig, type ReliabilityState } from "./reliability.ts";
import type { QuotaRoutingConfig, QuotaSnapshot } from "./quota.ts";

export type RoutingStrategy =
  | "first"
  | "cheapest"
  | "cheapest_input"
  | "cheapest_output"
  | "largest_context"
  | "random"
  | "fastest"
  | "subscription_balance"
  | "subscription_preferred";

export interface RouteRule {
  pattern: string;
  model: string;
}

export function modelKey(model: Model<Api> | undefined): string {
  if (!model) return "none";
  return `${model.provider}/${model.id}`;
}

export function supportsImageInput(model: Model<Api>): boolean {
  return model.input.includes("image");
}

/** Sum of input + output token costs per 1M tokens. Does not include cache read/write costs. */
export function modelCost(model: Model<Api>): number {
  return model.cost.input + model.cost.output;
}

/** Input token cost only. */
export function modelInputCost(model: Model<Api>): number {
  return model.cost.input;
}

/** Output token cost only. */
export function modelOutputCost(model: Model<Api>): number {
  return model.cost.output;
}

/** Context window size. */
export function modelContextSize(model: Model<Api>): number {
  return model.contextWindow;
}

export function findOneModel(
  ctx: ExtensionContext,
  pattern: string,
): Model<Api> | undefined {
  if (!pattern) return undefined;

  if (pattern.includes("/")) {
    const [provider, ...idParts] = pattern.split("/");
    const id = idParts.join("/");
    return ctx.modelRegistry.find(provider, id);
  }

  const lower = pattern.toLowerCase();
  const available = ctx.modelRegistry.getAvailable();
  return available.find(
    (m) =>
      m.id.toLowerCase().includes(lower) ||
      m.provider.toLowerCase().includes(lower),
  );
}

export function findCandidates(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
): Model<Api>[] {
  if (!pattern) return [];

  const candidates: Model<Api>[] = [];
  const seen = new Set<string>();
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  // Resolve once — avoid N getAvailable() calls for N substring patterns.
  const available = ctx.modelRegistry.getAvailable();

  for (const p of patterns) {
    if (p.includes("/")) {
      const model = findOneModel(ctx, p);
      if (model) {
        const key = modelKey(model);
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(model);
        }
      }
    } else {
      const lower = p.toLowerCase();
      for (const m of available) {
        if (
          !seen.has(modelKey(m)) &&
          (m.id.toLowerCase().includes(lower) ||
            m.provider.toLowerCase().includes(lower))
        ) {
          seen.add(modelKey(m));
          candidates.push(m);
        }
      }
    }
  }

  return candidates;
}

export function diagnoseCandidates(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
): { candidates: Model<Api>[]; unresolved: string[] } {
  if (!pattern) return { candidates: [], unresolved: [] };

  const candidates: Model<Api>[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const available = ctx.modelRegistry.getAvailable();

  for (const p of patterns) {
    let found = false;
    if (p.includes("/")) {
      const model = findOneModel(ctx, p);
      if (model) {
        found = true;
        const key = modelKey(model);
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(model);
        }
      }
    } else {
      const lower = p.toLowerCase();
      for (const m of available) {
        if (
          (m.id.toLowerCase().includes(lower) ||
            m.provider.toLowerCase().includes(lower))
        ) {
          found = true;
          if (!seen.has(modelKey(m))) {
            seen.add(modelKey(m));
            candidates.push(m);
          }
        }
      }
    }
    if (!found) unresolved.push(p);
  }

  return { candidates, unresolved };
}

export function selectModel(
  candidates: Model<Api>[],
  strategy: RoutingStrategy,
  quota?: QuotaSnapshot,
  quotaConfig?: QuotaRoutingConfig,
  now = Date.now(),
): Model<Api> | undefined {
  if (candidates.length === 0) return undefined;

  switch (strategy) {
    case "cheapest":
      return [...candidates].sort((a, b) => modelCost(a) - modelCost(b))[0];
    case "cheapest_input":
      return [...candidates].sort((a, b) => modelInputCost(a) - modelInputCost(b))[0];
    case "cheapest_output":
      return [...candidates].sort((a, b) => modelOutputCost(a) - modelOutputCost(b))[0];
    case "largest_context":
      return [...candidates].sort((a, b) => modelContextSize(b) - modelContextSize(a))[0];
    case "random":
      return candidates[Math.floor(Math.random() * candidates.length)];
    case "subscription_balance": {
      const preference = weeklyQuotaPreference(candidates, quota, quotaConfig, now);
      if (preference.ignoreWeeklyQuota) return preference.candidates[0];
      return selectWeighted(
        preference.candidates,
        subscriptionWeights(preference.candidates, quota, quotaConfig, now),
      );
    }
    case "subscription_preferred": {
      // Prioritize subscription models, then balance their weekly allowances within 10%.
      const subscriptionModels = candidates.filter((m) => billingClass(m) === "subscription");
      const freeModels = candidates.filter((m) => billingClass(m) === "free");
      const paidCreditModels = candidates.filter((m) => billingClass(m) === "paid-credit");
      const otherModels = candidates.filter((m) => billingClass(m) === "unknown");

      // If we have subscription models, use them with quota balancing
      if (subscriptionModels.length > 0) {
        const preference = weeklyQuotaPreference(subscriptionModels, quota, quotaConfig, now);
        if (preference.ignoreWeeklyQuota) return preference.candidates[0];
        return selectWeighted(
          preference.candidates,
          subscriptionWeights(preference.candidates, quota, quotaConfig, now),
        );
      }

      // Fallback: free models, then others
      if (freeModels.length > 0) {
        return selectModel(freeModels, "first");
      }
      if (otherModels.length > 0) {
        return selectModel(otherModels, "first");
      }
      return selectModel(paidCreditModels, "first");
    }
    default:
      // "first", "fastest" — list order is assumed meaningful.
      return candidates[0];
  }
}

// ── Subscription-aware weighting ────────────────────────────────────

export type BillingClass = "subscription" | "free" | "paid-credit" | "unknown";

/**
 * Classify a model's billing. Cost-free models are always usable;
 * subscription providers (Codex/Antigravity) carry the weekly quota;
 * OpenRouter-compatible hubs are credit-based. Unknown providers are
 * treated neutrally (never blocked, never biased).
 */
export function billingClass(model: Model<Api>): BillingClass {
  if (modelCost(model) <= 0) return "free";
  const p = model.provider.toLowerCase();
  if (p === "openai-codex" || p === "codex" || p === "antigravity" || p === "anthropic") {
    return "subscription";
  }
  if (/openrouter|opencode/.test(p)) return "paid-credit";
  return "unknown";
}

const WEEKLY_BALANCE_TOLERANCE = 0.10;

function weeklyQuotaPreference(
  candidates: Model<Api>[],
  quota: QuotaSnapshot | undefined,
  cfg: QuotaRoutingConfig | undefined,
  now: number,
): { candidates: Model<Api>[]; ignoreWeeklyQuota: boolean } {
  const fresh = quota && now - quota.fetchedAt < (cfg?.staleMinutes ?? 15) * 60_000;
  if (!fresh) return { candidates, ignoreWeeklyQuota: false };

  const byProvider = new Map<string, number>();
  for (const model of candidates) {
    if (billingClass(model) !== "subscription") continue;
    const remaining = quota.byProvider[model.provider]?.weeklyRemainingFraction;
    if (typeof remaining === "number") byProvider.set(model.provider, remaining);
  }
  if (byProvider.size < 2) return { candidates, ignoreWeeklyQuota: false };

  const ranked = [...byProvider].sort((a, b) => b[1] - a[1]);
  const [bestProvider, bestRemaining] = ranked[0];
  const secondRemaining = ranked[1][1];
  if (bestRemaining - secondRemaining <= WEEKLY_BALANCE_TOLERANCE + Number.EPSILON) {
    return { candidates, ignoreWeeklyQuota: true };
  }
  if (bestRemaining <= (cfg?.reservePercent ?? 0.03)) {
    return { candidates, ignoreWeeklyQuota: false };
  }

  return {
    candidates: candidates.filter((model) => model.provider === bestProvider),
    ignoreWeeklyQuota: false,
  };
}

/**
 * Weights for `subscription_balance`.
 *
 * - free: weight 1 always (zero cost, nothing to conserve)
 * - subscription: weight = weeklyRemainingFraction^gamma — the provider
 *   with more remaining allowance is favored harder as gamma grows;
 *   near equilibrium the weights converge toward even. A subscription
 *   with no fresh telemetry gets a conservative 0.5 so it can't
 *   outrank a measured healthy subscription.
 * - paid-credit: weight 0 while any measured subscription still has
 *   allowance above `reservePercent`; unblocked once subscriptions are
 *   drained or when no subscription telemetry is available at all.
 * - unknown: weight 1 (no telemetry → no bias, but never blocked)
 *
 * A globally stale or empty snapshot degrades everything to weight 1
 * (uniform) — no data → no bias, and paid credits are never starved.
 */
export function subscriptionWeights(
  candidates: Model<Api>[],
  quota: QuotaSnapshot | undefined,
  cfg: QuotaRoutingConfig | undefined,
  now = Date.now(),
): number[] {
  const reserve = cfg?.reservePercent ?? 0.03;
  const gamma = cfg?.gamma ?? 3;
  const fresh =
    quota !== undefined && now - quota.fetchedAt < (cfg?.staleMinutes ?? 15) * 60_000;

  // Only measured subscriptions can block credits; an unmeasured one can't
  // prove remaining allowance, so it must not keep the user off credits.
  const measuredSubs = fresh
    ? candidates.filter(
        (m) =>
          billingClass(m) === "subscription" &&
          typeof quota!.byProvider[m.provider]?.weeklyRemainingFraction === "number",
      )
    : [];
  const anySubAboveReserve = measuredSubs.some((m) => {
    const w = quota!.byProvider[m.provider]?.weeklyRemainingFraction;
    return typeof w === "number" && w > reserve;
  });
  // 0.5-for-unmeasured only applies when we DO have signal on another
  // subscription; a totally empty snapshot stays uniform (no data at all).
  const anyMeasuredSub = measuredSubs.length > 0;

  return candidates.map((m) => {
    switch (billingClass(m)) {
      case "free":
        return 1;
      case "paid-credit":
        return anySubAboveReserve ? 0 : 1;
      case "subscription": {
        if (!fresh || !anyMeasuredSub) return 1;
        const w = quota!.byProvider[m.provider]?.weeklyRemainingFraction;
        if (typeof w !== "number") return 0.5; // unmeasured: conservative, not dominant
        if (w <= reserve) return 0.05; // measured & drained — lose to credits
        return Math.pow(w, gamma);
      }
      default:
        return 1;
    }
  });
}

/** Weighted random pick. Zero-weight items never win; all-zero degenerates to uniform. */
export function selectWeighted<T>(items: readonly T[], weights: readonly number[]): T | undefined {
  if (items.length === 0) return undefined;
  const total = items.reduce((sum, _, i) => sum + Math.max(0, weights[i] ?? 0), 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i] ?? 0);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function resolveModel(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
  strategy: RoutingStrategy,
): Model<Api> | undefined {
  return selectModel(findCandidates(ctx, pattern), strategy);
}

export interface TierCandidateGroup {
  tier: string;
  candidates: Model<Api>[];
  strategy: RoutingStrategy;
}

export function selectImageCapableModelFromGroups(
  groups: readonly TierCandidateGroup[],
): { tier: string; model: Model<Api> } | undefined {
  for (const group of groups) {
    const model = selectModel(
      group.candidates.filter(supportsImageInput),
      group.strategy,
    );
    if (model) return { tier: group.tier, model };
  }
  return undefined;
}

export interface SkippedCandidate {
  key: string;
  reason: "open_circuit" | "quota_exhausted" | "session_exhausted";
  openUntil?: number;
}

export function isProviderQuotaExhausted(
  model: Model<Api>,
  quota: QuotaSnapshot | undefined,
  quotaConfig: QuotaRoutingConfig | undefined,
  now = Date.now(),
): boolean {
  if (!quota || now - quota.fetchedAt >= (quotaConfig?.staleMinutes ?? 15) * 60_000) return false;
  const remaining = quota.byProvider[model.provider]?.weeklyRemainingFraction;
  return typeof remaining === "number" && remaining <= (quotaConfig?.reservePercent ?? 0.03);
}

/** Pick another scoped model in the same capability tier with measured quota available. */
export function selectComparableAvailableModel(
  current: Model<Api>,
  candidates: Model<Api>[],
  strategy: RoutingStrategy,
  quota: QuotaSnapshot | undefined,
  quotaConfig: QuotaRoutingConfig | undefined,
  now = Date.now(),
): Model<Api> | undefined {
  if (!isProviderQuotaExhausted(current, quota, quotaConfig, now) || !quota) return undefined;
  const reserve = quotaConfig?.reservePercent ?? 0.03;
  const tier = guessTier(current);
  const available = candidates.filter((model) =>
    model.provider !== current.provider &&
    guessTier(model) === tier &&
    (quota.byProvider[model.provider]?.weeklyRemainingFraction ?? -1) > reserve
  );
  return selectModel(available, strategy, quota, quotaConfig, now);
}

/** Remove models from providers whose weekly quota is exhausted.
 *  Only applies when quota telemetry is fresh (within staleMinutes).
 *  Never removes ALL candidates — that would deadlock the user. */
export function filterQuotaExhausted(
  candidates: Model<Api>[],
  quota: QuotaSnapshot | undefined,
  quotaConfig: QuotaRoutingConfig | undefined,
  now: number,
): { candidates: Model<Api>[]; skipped: SkippedCandidate[] } {
  if (!quota) return { candidates, skipped: [] };
  const fresh = now - quota.fetchedAt < (quotaConfig?.staleMinutes ?? 15) * 60_000;
  if (!fresh) return { candidates, skipped: [] };

  const reserve = quotaConfig?.reservePercent ?? 0.03;
  const skipped: SkippedCandidate[] = [];
  const filtered = candidates.filter((model) => {
    if (billingClass(model) !== "subscription") return true;
    const remaining = quota.byProvider[model.provider]?.weeklyRemainingFraction;
    // No data: keep the model (conservative — unmeasured means unblocked)
    if (typeof remaining !== "number") return true;
    if (remaining <= reserve) {
      skipped.push({ key: modelKey(model), reason: "quota_exhausted" });
      return false;
    }
    return true;
  });

  // Don't starve the user — keep at least one candidate
  if (filtered.length === 0) return { candidates, skipped: [] };
  return { candidates: filtered, skipped };
}

/** Remove models from providers whose rolling session allowance is near-exhausted.
 *  Only applies when session telemetry is fresh (within staleMinutes). The `quick`
 *  tier is exempt from the near-exhausted reserve — short requests can still
 *  squeeze through a nearly-drained session — but a fully-drained (0%) session
 *  is a guaranteed 429 for every tier, so it is always blocked.
 *  Never removes ALL candidates — that would deadlock the user. */
export function filterSessionExhausted(
  candidates: Model<Api>[],
  quota: QuotaSnapshot | undefined,
  quotaConfig: QuotaRoutingConfig | undefined,
  now: number,
  tier?: string,
): { candidates: Model<Api>[]; skipped: SkippedCandidate[] } {
  if (!quota) return { candidates, skipped: [] };
  const fresh = now - quota.fetchedAt < (quotaConfig?.staleMinutes ?? 15) * 60_000;
  if (!fresh) return { candidates, skipped: [] };

  const reserve = quotaConfig?.sessionReservePercent ?? 0.10;
  const skipped: SkippedCandidate[] = [];
  const filtered = candidates.filter((model) => {
    if (billingClass(model) !== "subscription") return true;
    const remaining = quota.byProvider[model.provider]?.sessionRemainingFraction;
    // No session data: keep the model (unmeasured means unblocked)
    if (typeof remaining !== "number") return true;
    // 0% remaining is a hard block for every tier; no request squeezes through.
    if (remaining <= 0) {
      skipped.push({ key: modelKey(model), reason: "session_exhausted" });
      return false;
    }
    // Near-exhausted sessions are tolerated only for `quick`.
    if (tier !== "quick" && remaining < reserve) {
      skipped.push({ key: modelKey(model), reason: "session_exhausted" });
      return false;
    }
    return true;
  });

  // Don't starve the user — keep at least one candidate
  if (filtered.length === 0) return { candidates, skipped: [] };
  return { candidates: filtered, skipped };
}

export interface HealthyModelResolution {
  selected: Model<Api> | undefined;
  candidates: Model<Api>[];
  healthyCandidates: Model<Api>[];
  skipped: SkippedCandidate[];
}

export interface RoutedModelResolution {
  requestedTier: string;
  selectedTier?: string;
  selected: Model<Api> | undefined;
  strategy: RoutingStrategy;
  skipped: SkippedCandidate[];
  fallbackReason?: "requested_tier_unhealthy" | "requested_tier_unavailable" | "all_tiers_exhausted";
  primary: HealthyModelResolution;
  fallback?: HealthyModelResolution;
}

export function resolveHealthyModel(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
  strategy: RoutingStrategy,
  reliabilityState: ReliabilityState | undefined,
  reliabilityConfig: ReliabilityConfig | undefined,
  now = Date.now(),
  quota?: QuotaSnapshot,
  quotaConfig?: QuotaRoutingConfig,
  resolvedCandidates?: readonly Model<Api>[],
  tier?: string,
): HealthyModelResolution {
  const candidates = resolvedCandidates ? [...resolvedCandidates] : findCandidates(ctx, pattern);
  if (!reliabilityState || reliabilityConfig?.enabled === false) {
    const quotaFiltered = filterQuotaExhausted(candidates, quota, quotaConfig, now);
    const sessionFiltered = filterSessionExhausted(quotaFiltered.candidates, quota, quotaConfig, now, tier);
    return {
      selected: selectModel(sessionFiltered.candidates, strategy, quota, quotaConfig, now),
      candidates,
      healthyCandidates: candidates,
      skipped: [...quotaFiltered.skipped, ...sessionFiltered.skipped],
    };
  }

  const healthyCandidates: Model<Api>[] = [];
  const skipped: SkippedCandidate[] = [];
  for (const candidate of candidates) {
    const circuit = getCircuitState(reliabilityState, modelKey(candidate), now, reliabilityConfig);
    if (circuit.open) {
      skipped.push({ key: modelKey(candidate), reason: "open_circuit", openUntil: circuit.openUntil });
      continue;
    }
    healthyCandidates.push(candidate);
  }

  // Filter out models from providers with exhausted weekly quota.
  // Guard: if all candidates would be removed, keep the original set.
  const quotaFiltered = filterQuotaExhausted(healthyCandidates, quota, quotaConfig, now);
  const sessionFiltered = filterSessionExhausted(quotaFiltered.candidates, quota, quotaConfig, now, tier);
  const allSkipped = [...skipped, ...quotaFiltered.skipped, ...sessionFiltered.skipped];

  return {
    selected: selectModel(sessionFiltered.candidates, strategy, quota, quotaConfig, now),
    candidates,
    healthyCandidates,
    skipped: allSkipped,
  };
}

export function resolveModelWithFallback(
  ctx: ExtensionContext,
  options: {
    requestedTier: string;
    requestedPattern: string | string[] | undefined;
    requestedStrategy: RoutingStrategy;
    defaultTier?: string;
    defaultPattern?: string | string[] | undefined;
    defaultStrategy?: RoutingStrategy;
    reliabilityState?: ReliabilityState;
    reliabilityConfig?: ReliabilityConfig;
    quota?: QuotaSnapshot;
    quotaConfig?: QuotaRoutingConfig;
    requestedCandidates?: readonly Model<Api>[];
    defaultCandidates?: readonly Model<Api>[];
    now?: number;
    /** When true, never fall back to `defaultTier` if the requested tier has
     *  no healthy candidate. Used for strict categories (e.g. `coding`)
     *  where falling back would silently select an unapproved cross-category
     *  model instead of surfacing the unavailable/unhealthy result. */
    strict?: boolean;
  },
): RoutedModelResolution {
  const now = options.now ?? Date.now();
  const primary = resolveHealthyModel(
    ctx,
    options.requestedPattern,
    options.requestedStrategy,
    options.reliabilityState,
    options.reliabilityConfig,
    now,
    options.quota,
    options.quotaConfig,
    options.requestedCandidates,
    options.requestedTier,
  );
  if (primary.selected) {
    return {
      requestedTier: options.requestedTier,
      selectedTier: options.requestedTier,
      selected: primary.selected,
      strategy: options.requestedStrategy,
      skipped: primary.skipped,
      primary,
    };
  }

  const requestedUnavailable = primary.candidates.length === 0;
  let fallbackReason: RoutedModelResolution["fallbackReason"] = requestedUnavailable
    ? "requested_tier_unavailable"
    : (primary.skipped.length > 0 ? "requested_tier_unhealthy" : undefined);

  if (options.strict) {
    return {
      requestedTier: options.requestedTier,
      selected: undefined,
      strategy: options.requestedStrategy,
      skipped: primary.skipped,
      fallbackReason,
      primary,
    };
  }

  // Compute final reason after evaluating fallback
  const resolveFinalReason = (fb: HealthyModelResolution): RoutedModelResolution["fallbackReason"] => {
    if (fb.selected) return fallbackReason;
    if (requestedUnavailable && fb.candidates.length === 0) return "requested_tier_unavailable";
    if (fb.skipped.length > 0 || primary.skipped.length > 0) return "all_tiers_exhausted";
    return fallbackReason;
  };

  if (!options.defaultTier || options.defaultTier === options.requestedTier) {
    return {
      requestedTier: options.requestedTier,
      selected: undefined,
      strategy: options.requestedStrategy,
      skipped: primary.skipped,
      fallbackReason,
      primary,
    };
  }

  const fallback = resolveHealthyModel(
    ctx,
    options.defaultPattern,
    options.defaultStrategy ?? options.requestedStrategy,
    options.reliabilityState,
    options.reliabilityConfig,
    now,
    options.quota,
    options.quotaConfig,
    options.defaultCandidates,
    options.defaultTier,
  );

  return {
    requestedTier: options.requestedTier,
    selectedTier: fallback.selected ? options.defaultTier : undefined,
    selected: fallback.selected,
    strategy: fallback.selected
      ? (options.defaultStrategy ?? options.requestedStrategy)
      : options.requestedStrategy,
    skipped: [...primary.skipped, ...fallback.skipped],
    fallbackReason: resolveFinalReason(fallback),
    primary,
    fallback,
  };
}

export function getStrategy(
  categoryStrategies: Record<string, RoutingStrategy> | undefined,
  fallbackStrategy: RoutingStrategy | undefined,
  category: string,
): RoutingStrategy {
  return categoryStrategies?.[category] ?? fallbackStrategy ?? "first";
}

export function classify(text: string, rules: readonly RouteRule[]): string | undefined {
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, "i");
      if (re.test(text)) return rule.model;
    } catch (err) {
      console.error(`[bifrost] invalid regex "${rule.pattern}": ${err}`);
    }
  }
  return undefined;
}

// ── Tier heuristics ───────────────────────────────────────────

/**
 * Tier assignment during `/bifrost init`, using billing class plus
 * cost/context signals. Listed cost is meaningless for subscription
 * providers (Codex/Antigravity), so those are tiered by context window
 * instead. Free models (cost <= 0) have no cost signal either, so they
 * are also tiered by context window. Everything else (paid) keeps the
 * original cost-threshold behavior. No name-based guessing — naming
 * conventions change; billing class + cost/context is the stable signal.
 */
const FRONTIER_COST_THRESHOLD = 5; // $/1M tokens (input + output)
const QUICK_COST_THRESHOLD = 1;
const SUBSCRIPTION_FRONTIER_CONTEXT = 200_000;
const SUBSCRIPTION_GENERAL_CONTEXT = 64_000;
const FREE_GENERAL_CONTEXT = 200_000;

export type BifrostTier = "frontier" | "general" | "writing" | "quick";

/** Assign a model to a tier based on billing class, cost, and context window. */
export function guessTier(
  model: Model<Api>,
): BifrostTier {
  const contextWindow = model.contextWindow ?? 0;
  const cost = model.cost ? modelCost(model) : 0;
  const cls: BillingClass = model.cost ? billingClass(model) : "free";

  if (cls === "subscription") {
    if (contextWindow >= SUBSCRIPTION_FRONTIER_CONTEXT) return "frontier";
    if (contextWindow >= SUBSCRIPTION_GENERAL_CONTEXT) return "general";
    return "quick";
  }
  if (cls === "free") {
    if (contextWindow >= FREE_GENERAL_CONTEXT) return "general";
    return "quick";
  }
  if (cost > FRONTIER_COST_THRESHOLD) return "frontier";
  if (cost < QUICK_COST_THRESHOLD) return "quick";
  return "general";
}
