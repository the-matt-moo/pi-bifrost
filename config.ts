import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readJsonFile } from "./storage.ts";
import type { RoutingStrategy, RouteRule } from "./routing.ts";
import type { CacheOptions } from "./cache.ts";
import type { DebugConfig } from "./debug.ts";
import type { ReliabilityConfig } from "./reliability.ts";
import type { QuotaRoutingConfig } from "./quota.ts";
import type { ThinkingLevel } from "./thinking.ts";

type ClassifierMethod = "direct" | "subprocess" | "auto";

export type DiscoverySource = "scoped" | "free";

export interface DiscoveryConfig {
  managed: Record<string, DiscoverySource[]>;
}

export interface ClassifierConfig {
  enabled?: boolean;
  model?: string | string[];
  /** Ordered fallback classifier models tried after `model`. */
  fallbackModels?: string[];
  endpoint?: string;
  method?: ClassifierMethod;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** Total classifier budget across model attempts. */
  timeoutMs?: number;
  /** Maximum classifier models attempted per prompt. */
  maxAttempts?: number;
  /** Temporary cooldown after a failed classifier attempt. */
  cooldownSeconds?: number;
  fallbackToRegex?: boolean;
  /** Minimum LLM-confidence (0-1) required to accept a classifier tier.
   *  Lower-confidence classifications fall through to regex/fallback,
   *  keeping the current model stable and reducing model-switch cache misses. */
  confidenceThreshold?: number;
}

export interface ThinkingConfig {
  mode?: "off" | "advisory" | "apply";
  defaultLevel?: ThinkingLevel;
  maxLevel?: ThinkingLevel;
  byTier?: Record<string, ThinkingLevel>;
}

/** Per-machine key bindings. Pi's extension API takes literal keys, not remappable action ids,
 *  so keys live in bifrost.json (machine-local) instead of being hardcoded here. */
export interface KeysConfig {
  /** Pin Bifrost to the current model. Unset = not bound. */
  pin?: string;
  /** Unpin model + thinking. Unset = not bound. */
  unpin?: string;
}

export interface BifrostConfig {
  enabled?: boolean;
  keys?: KeysConfig;
  silent?: boolean;
  default?: string;
  strategy?: RoutingStrategy;
  categoryStrategies?: Record<string, RoutingStrategy>;
  models?: Record<string, string | string[]>;
  rules?: RouteRule[];
  classifier?: ClassifierConfig;
  cache?: CacheOptions;
  debug?: DebugConfig;
  reliability?: ReliabilityConfig;
  discovery?: DiscoveryConfig;
  quotaRouting?: QuotaRoutingConfig;
  thinking?: ThinkingConfig;
}

export const DEFAULT_RULES: RouteRule[] = [
  {
    pattern:
      "(^|\\s)\\/?commit(?:\\s|$)|\\b(commit message|conventional commit|git commit message)\\b",
    model: "quick",
  },
  {
    pattern:
      "(^|\\s)\\/?format(?:\\s|$)|\\b(prettify|reformat|format this json|format this yaml|format this code)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(json to yaml|yaml to json|csv to json|json to csv|convert this data)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(fix lint|lint errors?|eslint errors?|prettier errors?|stylelint errors?)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(generate mock data|create mock data|sample json|dummy data|fixture data)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(translate this|proofread this|fix grammar|grammar check|rewrite this sentence)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(classify these|extract fields?|extract values?|extract entities|parse this text)\\b",
    model: "quick",
  },
  {
    pattern:
      "(^|\\s)\\/?test(?:\\s|$)|\\b(unit tests?|integration tests?|e2e tests?|test cases?|write tests?|generate tests?|test coverage|test fixtures?)\\b",
    model: "general",
  },
  {
    pattern:
      "\\b(refactor|restructure|reorganize|clean up|simplify this|extract method|extract function|extract component|move this|rename this)\\b",
    model: "general",
  },
  {
    pattern:
      "\\b(implement|add feature|create a|build a|write a|set up|scaffold|boilerplate|skeleton|stub)\\b",
    model: "general",
  },
  {
    pattern:
      "\\b(explain this|explain how|explain why|what does this|how does this|walk me through|describe this)\\b",
    model: "writing",
  },
  {
    pattern:
      "\\b(write docs?|write documentation|add comments|document this|jsdoc|docstring|readme|write a guide|write a tutorial|write a summary|summarize this|write a report|write an email|write a proposal|write a description|write a message)\\b",
    model: "writing",
  },
  {
    pattern:
      "\\b(add error handling|add validation|add logging|add types?|add interface|add typing|type this)\\b",
    model: "general",
  },
  {
    pattern:
      "\\b(api integration|connect to|call the api|http request|fetch from|rest endpoint|graphql query)\\b",
    model: "general",
  },
  {
    pattern:
      "(^|\\s)\\/?review(?:\\s|$)|\\b(review this code|review this diff|review this pull request|review this pr|code review|audit this code|security review of this code)\\b",
    model: "frontier",
  },
  {
    pattern:
      "(^|\\s)\\/?debug(?:\\s|$)|\\b(debug|diagnose|fix bug|stack trace|runtime error|compile error|build error|failing build|exception|crash|incorrect output|unexpected behaviou?r|flaky test)\\b",
    model: "frontier",
  },
  {
    pattern:
      "(^|\\s)\\/?arch(?:\\s|$)|\\b(system architecture|software architecture|architect this|architect a|distributed system design|microservices architecture|database architecture|database design|schema design|api design|migration architecture|scalability plan|capacity planning|repository-wide refactor|major refactor)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(race condition|deadlock|memory leak|segmentation fault|heisenbug|concurrency bug|production incident|root cause analysis|performance regression)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(security audit|threat model|vulnerability analysis|authentication flaw|authorization flaw|sql injection|cross-site scripting|\\bxss\\b|\\bcsrf\\b|remote code execution|privilege escalation)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(mathematical proof|prove that|formal proof|complex reasoning|logical puzzle|derive the equation|algorithmic proof)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(maximum quality|highest quality|best available model|strongest model|ignore cost|cost does not matter|cost isn't important|spare no expense)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(use a free model|free model only|no paid model|zero cost|spend nothing|do not spend)\\b",
    model: "quick",
  },
];

export const ALL_STRATEGIES: readonly RoutingStrategy[] = [
  "first",
  "cheapest",
  "cheapest_input",
  "cheapest_output",
  "largest_context",
  "random",
  "fastest",
  "subscription_balance",
];

export interface ConfigIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * Validate a resolved BifrostConfig. Returns issues (errors stop
 * the extension from starting, warnings are logged only).
 */
export function validateConfig(
  config: BifrostConfig,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const modelKeys = Object.keys(config.models ?? {});

  if (modelKeys.length === 0) {
    issues.push({
      severity: "error",
      message:
        'No tiers configured in "models". Add at least one tier to .pi/bifrost.json.',
    });
  }

  if (config.default && !modelKeys.includes(config.default)) {
    issues.push({
      severity: "error",
      message: `Default tier "${config.default}" not found in models [${modelKeys.join(", ")}].`,
    });
  }

  if (config.categoryStrategies) {
    for (const tier of Object.keys(config.categoryStrategies)) {
      if (!modelKeys.includes(tier)) {
        issues.push({
          severity: "error",
          message: `Category strategy for tier "${tier}" — tier not found in models [${modelKeys.join(", ")}].`,
        });
      }
    }
  }

  const thinking = config.thinking;
  const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const [name, level] of [
    ["defaultLevel", thinking?.defaultLevel],
    ["maxLevel", thinking?.maxLevel],
  ] as const) {
    if (level !== undefined && !thinkingLevels.has(level)) {
      issues.push({ severity: "warning", message: `Unknown thinking.${name} level "${level}".` });
    }
  }
  if (thinking?.mode !== undefined && !["off", "advisory", "apply"].includes(thinking.mode)) {
    issues.push({ severity: "warning", message: `Unknown thinking.mode "${thinking.mode}".` });
  }
  for (const [tier, level] of Object.entries(thinking?.byTier ?? {})) {
    if (!modelKeys.includes(tier)) {
      issues.push({ severity: "error", message: `Thinking level for tier "${tier}" — tier not found in models [${modelKeys.join(", ")}].` });
    }
    if (!thinkingLevels.has(level)) {
      issues.push({ severity: "warning", message: `Unknown thinking.byTier.${tier} level "${level}".` });
    }
  }

  const strat = config.strategy;
  if (strat && !ALL_STRATEGIES.includes(strat as RoutingStrategy)) {
    issues.push({
      severity: "warning",
      message: `Unknown strategy "${strat}" — falling back to "first".`,
    });
  }

  if (config.cache?.threshold !== undefined && (config.cache.threshold < 0 || config.cache.threshold > 1)) {
    issues.push({
      severity: "error",
      message: `Cache threshold must be between 0 and 1, got ${config.cache.threshold}.`,
    });
  }

  if (config.cache?.maxEntries !== undefined && config.cache.maxEntries < 1) {
    issues.push({
      severity: "warning",
      message: `Cache maxEntries is ${config.cache.maxEntries}, should be > 0.`,
    });
  }

  const classifier = config.classifier;
  if (classifier?.timeoutMs !== undefined && (!Number.isFinite(classifier.timeoutMs) || classifier.timeoutMs < 1)) {
    issues.push({ severity: "error", message: `Classifier timeoutMs must be >= 1, got ${classifier.timeoutMs}.` });
  }
  if (classifier?.maxAttempts !== undefined && (!Number.isInteger(classifier.maxAttempts) || classifier.maxAttempts < 1)) {
    issues.push({ severity: "error", message: `Classifier maxAttempts must be an integer >= 1, got ${classifier.maxAttempts}.` });
  }
  if (classifier?.cooldownSeconds !== undefined && (!Number.isFinite(classifier.cooldownSeconds) || classifier.cooldownSeconds < 0)) {
    issues.push({ severity: "error", message: `Classifier cooldownSeconds must be >= 0, got ${classifier.cooldownSeconds}.` });
  }
  if (classifier?.confidenceThreshold !== undefined &&
      (!Number.isFinite(classifier.confidenceThreshold) || classifier.confidenceThreshold < 0 || classifier.confidenceThreshold > 1)) {
    issues.push({ severity: "error", message: `Classifier confidenceThreshold must be between 0 and 1, got ${classifier.confidenceThreshold}.` });
  }
  const quota = config.quotaRouting;
  if (quota?.reservePercent !== undefined && (quota.reservePercent < 0 || quota.reservePercent > 1)) {
    issues.push({
      severity: "warning",
      message: `quotaRouting.reservePercent must be between 0 and 1, got ${quota.reservePercent}.`,
    });
  }
  if (quota?.sessionReservePercent !== undefined && (quota.sessionReservePercent < 0 || quota.sessionReservePercent > 1)) {
    issues.push({
      severity: "warning",
      message: `quotaRouting.sessionReservePercent must be between 0 and 1, got ${quota.sessionReservePercent}.`,
    });
  }
  if (quota?.gamma !== undefined && (quota.gamma < 0 || !Number.isFinite(quota.gamma))) {
    issues.push({
      severity: "warning",
      message: `quotaRouting.gamma must be a finite number >= 0, got ${quota.gamma}.`,
    });
  }

  const reliability = config.reliability;
  if (reliability?.failureThreshold !== undefined && (!Number.isInteger(reliability.failureThreshold) || reliability.failureThreshold < 1)) {
    issues.push({
      severity: "error",
      message: `Reliability failureThreshold must be an integer >= 1, got ${reliability.failureThreshold}.`,
    });
  }

  if (reliability?.windowMinutes !== undefined && (!Number.isInteger(reliability.windowMinutes) || reliability.windowMinutes < 1)) {
    issues.push({
      severity: "error",
      message: `Reliability windowMinutes must be an integer >= 1, got ${reliability.windowMinutes}.`,
    });
  }

  if (reliability?.cooldownMinutes !== undefined && (!Number.isInteger(reliability.cooldownMinutes) || reliability.cooldownMinutes < 1)) {
    issues.push({
      severity: "error",
      message: `Reliability cooldownMinutes must be an integer >= 1, got ${reliability.cooldownMinutes}.`,
    });
  }

  if (reliability?.maxAutoRetries !== undefined && (!Number.isInteger(reliability.maxAutoRetries) || reliability.maxAutoRetries < 0)) {
    issues.push({
      severity: "error",
      message: `Reliability maxAutoRetries must be an integer >= 0, got ${reliability.maxAutoRetries}.`,
    });
  }

  if (config.rules) {
    for (let i = 0; i < config.rules.length; i++) {
      const rule = config.rules[i];
      try {
        new RegExp(rule.pattern, "i");
      } catch {
        issues.push({
          severity: "error",
          message: `Invalid regex in rule #${i}: "${rule.pattern}".`,
        });
      }
    }
  }

  return issues;
}

export function readJson<T>(path: string): T | undefined {
  try {
    return readJsonFile<T>(path);
  } catch (err) {
    console.error(`[bifrost] failed to parse ${path}: ${err}`);
    return undefined;
  }
}

/**
 * Shallow-merge a nested object field only when at least one side defines it.
 * Keeps `undefined` when both sides are undefined (preserves "not set" vs "{}").
 */
function mergeObj<T extends object>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  if (base === undefined && override === undefined) return undefined;
  return { ...base, ...override } as T;
}

/**
 * Merge two BifrostConfig layers. Later layers win for primitives and
 * arrays; nested objects (models, classifier, cache, debug, strategies)
 * are shallow-merged key-by-key so per-tier overrides layer correctly.
 */
export function mergeConfig(
  base: BifrostConfig,
  override: BifrostConfig,
): BifrostConfig {
  const merged: BifrostConfig = { ...base, ...override };
  merged.categoryStrategies = mergeObj(
    base.categoryStrategies,
    override.categoryStrategies,
  );
  merged.models = mergeObj(base.models, override.models);
  merged.classifier = mergeObj(base.classifier, override.classifier);
  merged.cache = mergeObj(base.cache, override.cache);
  merged.debug = mergeObj(base.debug, override.debug);
  merged.reliability = mergeObj(base.reliability, override.reliability);
  merged.discovery = mergeObj(base.discovery, override.discovery);
  merged.quotaRouting = mergeObj(base.quotaRouting, override.quotaRouting);
  return merged;
}

export function loadConfig(
  cwd: string,
  extensionDir: string,
): BifrostConfig {
  const base: BifrostConfig = {
    enabled: true,
    silent: false,
    default: "general",
    strategy: "first",
    categoryStrategies: {
      quick: "first",
      general: "first",
      writing: "first",
      frontier: "first",
    },
    models: {},
    rules: DEFAULT_RULES,
  };

  const configs = [
    readJson<BifrostConfig>(join(extensionDir, "bifrost.json")),
    readJson<BifrostConfig>(join(getAgentDir(), "bifrost.json")),
    readJson<BifrostConfig>(join(cwd, "bifrost.json")),
    readJson<BifrostConfig>(join(cwd, CONFIG_DIR_NAME, "bifrost.json")),
  ];

  let merged: BifrostConfig = base;
  for (const cfg of configs) {
    if (cfg) merged = mergeConfig(merged, cfg);
  }
  return merged;
}

export function loadRules(cwd: string, config: BifrostConfig): RouteRule[] {
  const routeFiles = [
    join(cwd, CONFIG_DIR_NAME, "bifrost-routes.json"),
    join(cwd, "bifrost-routes.json"),
  ];

  for (const p of routeFiles) {
    const rules = readJson<RouteRule[]>(p);
    if (rules) return rules;
  }

  return config.rules?.length ? config.rules : DEFAULT_RULES;
}

export function generateTierDescriptions(rules: RouteRule[], tiers: readonly string[]): Record<string, string> {
  const keywords: Record<string, Set<string>> = {};
  for (const tier of tiers) keywords[tier] = new Set();

  for (const rule of rules) {
    if (!tiers.includes(rule.model)) continue;
    const cleaned = rule.pattern
      .replace(/\(\?\:[^)]*\)/g, "")
      .replace(/\\b/g, "")
      .replace(/\(\^?\|?\\s\)\??/g, "")
      .replace(/\\s/g, " ")
      .replace(/\\\//g, "/")
      .replace(/[()^$|\\?+*\[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    for (const word of cleaned.split(" ")) {
      if (word.length > 2) keywords[rule.model].add(word);
    }
  }

  const descriptions: Record<string, string> = {};
  for (const tier of tiers) {
    const words = [...keywords[tier]];
    if (words.length > 0) {
      descriptions[tier] = words.slice(0, 6).join(", ");
    }
  }
  return descriptions;
}
