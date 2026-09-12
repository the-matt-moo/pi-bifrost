import type { ClassifierAttempt, ClassifierModel } from "./classifier.ts";
import { classify as regexClassify, type RouteRule } from "./routing.ts";
import { debug, debugMeasure } from "./debug.ts";
import type { SessionRoutingContext } from "./session-context.ts";
import { assessComplexity } from "./complexity.ts";

// ── ADT result type ────────────────────────────────────────────

export type ClassificationSource = "cache" | "classifier" | "regex" | "complexity" | "inline";

export type ClassificationResult =
  | { readonly kind: "classified"; readonly tier: string; readonly source: ClassificationSource }
  | { readonly kind: "fallback"; readonly tier: string }
  | { readonly kind: "unclassified" };

export function autoPinSource(result: ClassificationResult): ClassificationSource | "fallback" | undefined {
  if (result.kind === "fallback") return "fallback";
  if (result.kind === "classified" && result.source !== "inline") return result.source;
  return undefined;
}

// ── Pipeline dependencies ──────────────────────────────────────

/**
 * Dependencies injected into the pipeline. All are in-process.
 *
 * `cacheLookup` may internally mutate its backing store for LRU
 * tracking — this is an accepted impurity (see ADR candidate #4).
 */
export interface PipelineDeps {
  /** Query cache. Returns tier or undefined. */
  readonly cacheLookup: (text: string) => string | undefined;
  /** Classifier models in priority order. Empty array = skip LLM. */
  readonly classifierModels: readonly ClassifierModel[];
  /** Invoke the LLM classifier for a single model. Returns tier or undefined. */
  readonly classifyWithLLM: (
    model: ClassifierModel,
    text: string,
    tiers: readonly string[],
    signal?: AbortSignal,
  ) => Promise<ClassifierAttempt | string | undefined>;
  /** Regex routing rules. First match wins. */
  readonly regexRules: readonly RouteRule[];
  /** Default tier when nothing matches. */
  readonly defaultTier: string | undefined;
  /** Known tier names, from config.models keys. */
  readonly tiers: readonly string[];
  /** Session routing context for multi-turn momentum. */
  readonly sessionContext?: SessionRoutingContext;
  /** Enable complexity-based short-circuiting. */
  readonly complexityEnabled?: boolean;
  /** Maximum classifier models attempted for one prompt. */
  readonly classifierMaxAttempts?: number;
  /** Total classifier wall-clock budget for one prompt. */
  readonly classifierTimeoutMs?: number;
  /** Temporary failure cooldown shared across pipeline rebuilds. */
  readonly classifierCooldownMs?: number;
  /** Fall back to tier regex rules after classifier rejection/failure. */
  readonly fallbackToRegex?: boolean;
  readonly classifierCooldowns?: Map<string, number>;
  readonly now?: () => number;
}

// ── Pipeline interface ─────────────────────────────────────────

export interface ClassificationPipeline {
  readonly classify: (text: string) => Promise<ClassificationResult>;
}

// ── Factory ────────────────────────────────────────────────────

export function createPipeline(deps: PipelineDeps): ClassificationPipeline {
  const {
    cacheLookup,
    classifierModels,
    classifyWithLLM,
    regexRules,
    defaultTier,
    tiers,
    sessionContext,
    complexityEnabled,
    classifierMaxAttempts = 2,
    classifierTimeoutMs = 10_000,
    classifierCooldownMs = 60_000,
    classifierCooldowns = new Map<string, number>(),
    fallbackToRegex = true,
    now = Date.now,
  } = deps;

  async function classify(text: string): Promise<ClassificationResult> {
    // Stage 1: regex pre-check — direct model references short-circuit everything.
    const endPre = debugMeasure("pipeline", "regex_pre");
    const regexResult = regexClassify(text, regexRules);
    endPre({ match: !!regexResult, tier: regexResult });
    if (regexResult && regexResult.includes("/") && !tiers.includes(regexResult)) {
      debug("pipeline", "result", { source: "regex", tier: regexResult, direct: true });
      return { kind: "classified", tier: regexResult, source: "regex" };
    }

    if (tiers.length === 0) return { kind: "unclassified" };

    // A configured-category regex match this turn takes priority over stale
    // cache/session signals from an earlier turn — otherwise "implement the
    // login endpoint" right after a planning-heavy session would inherit a
    // stale frontier tier instead of routing to the matched category.
    const regexTierMatch = regexResult && tiers.includes(regexResult) ? regexResult : undefined;

    // Stage 2: cache lookup
    const endCache = debugMeasure("pipeline", "cache");
    const cached = cacheLookup(text);
    endCache({ hit: !!cached });
    if (cached && tiers.includes(cached)) {
      if (!regexTierMatch || cached === regexTierMatch) {
        debug("pipeline", "result", { source: "cache", tier: cached });
        return { kind: "classified", tier: cached, source: "cache" };
      }
      debug("pipeline", "cache.stale_conflict", { cached, regexTierMatch });
    }

    // Stage 2.5: session momentum — reuse recent tier if conversation continues
    if (sessionContext) {
      const endSession = debugMeasure("pipeline", "session");
      const sessionTier = sessionContext.suggest(text);
      endSession({ tier: sessionTier });
      if (sessionTier && tiers.includes(sessionTier)) {
        if (!regexTierMatch || sessionTier === regexTierMatch) {
          debug("pipeline", "result", { source: "cache", tier: sessionTier, sessionMomentum: true });
          return { kind: "classified", tier: sessionTier, source: "cache" };
        }
        debug("pipeline", "session.stale_conflict", { sessionTier, regexTierMatch });
      }
    }

    // Stage 2.75: complexity heuristic — short-circuit for obvious cases.
    // Skipped once a configured category rule already matched this turn, so
    // quick/frontier complexity shortcuts never override explicit routing
    // intent (e.g. a short "fix bug" coding-rule match should not drop to
    // quick, and a long coding-rule match should not escalate to frontier).
    if (complexityEnabled !== false && !regexTierMatch) {
      const endComplexity = debugMeasure("pipeline", "complexity");
      const verdict = assessComplexity(text, tiers);
      endComplexity({ verdict });
      if (verdict && tiers.includes(verdict)) {
        debug("pipeline", "result", { source: "complexity", tier: verdict, complexity: true });
        return { kind: "classified", tier: verdict, source: "complexity" };
      }
    }

    // Stage 3: bounded LLM classifier — classifier accuracy beats regex tier matches.
    if (classifierModels.length > 0 && classifierMaxAttempts > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), classifierTimeoutMs);
      timer.unref?.();
      const timedOut = new Promise<undefined>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
      let attempts = 0;
      try {
        for (const model of classifierModels) {
          if (controller.signal.aborted || attempts >= classifierMaxAttempts) break;
          const modelId = model.kind === "registry"
            ? `${model.model.provider}/${model.model.id}`
            : `endpoint/${model.id}`;
          if ((classifierCooldowns.get(modelId) ?? 0) > now()) {
            debug("pipeline", "classifier.cooldown", { model: modelId });
            continue;
          }
          attempts++;
          try {
            const endLLM = debugMeasure("pipeline", "classifier.attempt");
            const rawOutcome = await Promise.race([
              classifyWithLLM(model, text, tiers, controller.signal),
              timedOut,
            ]);
            const outcome = typeof rawOutcome === "string"
              ? { status: "accepted" as const, tier: rawOutcome }
              : rawOutcome;
            endLLM({ model: modelId, status: outcome?.status });
            if (outcome?.status === "accepted" && tiers.includes(outcome.tier)) {
              classifierCooldowns.delete(modelId);
              debug("pipeline", "result", { source: "classifier", tier: outcome.tier });
              return { kind: "classified", tier: outcome.tier, source: "classifier" };
            }
            if (outcome?.status === "rejected") {
              classifierCooldowns.delete(modelId);
              debug("pipeline", "classifier.rejected", { model: modelId });
              break;
            }
            classifierCooldowns.set(modelId, now() + classifierCooldownMs);
          } catch (err) {
            classifierCooldowns.set(modelId, now() + classifierCooldownMs);
            debug("pipeline", "classifier.error", { model: modelId, error: String(err) });
            console.error(`[bifrost] classifier model failed: ${err}`);
          }
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // Stage 4: regex tier match — reuse the single regexResult (classifier already had priority).
    if (fallbackToRegex && regexTierMatch) {
      debug("pipeline", "result", { source: "regex", tier: regexTierMatch });
      return { kind: "classified", tier: regexTierMatch, source: "regex" };
    }

    // Stage 5: default fallback
    debug("pipeline", "result", { source: "fallback", tier: defaultTier });
    if (defaultTier) {
      return { kind: "fallback", tier: defaultTier };
    }

    return { kind: "unclassified" };
  }

  return { classify };
}
