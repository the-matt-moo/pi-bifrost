import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, parseFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { modelKey, scopedCandidates } from "./routing.ts";
import { clampToModel, type ThinkingLevel } from "./thinking.ts";

export interface AgentRoutingDefaults {
  model?: string;
  thinking?: string;
  locked?: unknown;
  enabled?: boolean;
}

/** Read only routing fields; pi-subagents remains the owner of agent execution/config. */
/** Build routing defaults from a resolved pi-subagents AgentConfig after locks resolve. */
export function agentRoutingDefaultsFromConfig(
  config: { name?: string; model?: string; thinking?: string; locked?: unknown; enabled?: boolean; isDefault?: boolean } | undefined,
): AgentRoutingDefaults {
  if (!config) return {};
  if (config.enabled === false) throw new Error(`Subagent ${config.name ?? ""} is disabled`.trim());
  // Built-in defaults carry no routing fields here; Bifrost classification replaces their model hints.
  if (config.isDefault) return { enabled: config.enabled };
  const rawLocked = config.locked;
  const lockList = rawLocked === true
    ? (["model", "thinking"] as const).filter((f) => config[f] !== undefined)
    : (Array.isArray(rawLocked) ? rawLocked : typeof rawLocked === "string" ? rawLocked.split(",").map((s) => s.trim()) : [])
        .filter((f: unknown): f is "model" | "thinking" => (f === "model" || f === "thinking") && config[f] !== undefined);
  return {
    model: config.model,
    thinking: config.thinking,
    locked: lockList.length > 0 ? lockList : undefined,
    enabled: config.enabled,
  };
}

export function loadAgentRoutingDefaults(cwd: string, type: string): AgentRoutingDefaults {
  // Built-in defaults carry no routing fields here; Bifrost classification replaces their model hints.
  const agents = new Map<string, AgentRoutingDefaults>([
    ["general-purpose", {}], ["Explore", {}], ["Plan", {}],
  ]);
  for (const dir of [join(getAgentDir(), "agents"), join(cwd, ".pi", "agents")]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      const { frontmatter } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
      agents.set(file.slice(0, -3), frontmatter as AgentRoutingDefaults);
    }
  }
  // pi-subagents runs unknown types as general-purpose, so route them the same way.
  const name = agents.has(type) ? type
    : [...agents.keys()].find((key) => key.toLowerCase() === type.toLowerCase()) ?? "general-purpose";
  const defaults = agents.get(name)!;
  if (defaults.enabled === false) throw new Error(`Subagent ${type} is disabled`);
  return defaults;
}

function locked(defaults: AgentRoutingDefaults, field: "model" | "thinking"): boolean {
  if (defaults.locked === true) return defaults[field] !== undefined;
  const fields = Array.isArray(defaults.locked) ? defaults.locked
    : typeof defaults.locked === "string" ? defaults.locked.split(",").map((s) => s.trim()) : [];
  return fields.includes(field);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface SpawnRoute {
  model: string;
  thinking: ThinkingLevel;
  modelSource: "caller" | "agent" | "bifrost";
  thinkingSource: "caller" | "agent" | "bifrost" | "default" | "scope";
  fallback: "stop";
}

export interface SpawnRoutingPolicy {
  select: (prompt: string) => Promise<{ model: Model<Api>; tier: string; effort?: number } | null>;
  thinking: (prompt: string, model: Model<Api>, tier?: string, effort?: number) => ThinkingLevel | undefined;
  defaultThinking: ThinkingLevel;
  validate: (model: Model<Api>) => string | undefined;
}

/** Resolve atomically: errors leave caller parameters untouched; resumes never enter here. */
export async function resolveSpawnRoute(
  input: Record<string, unknown>, defaults: AgentRoutingDefaults,
  ctx: ExtensionContext, policy: SpawnRoutingPolicy,
): Promise<SpawnRoute> {
  for (const field of ["model", "thinking"] as const) {
    if (input[field] !== undefined && !text(input[field])) throw new Error(`Invalid subagent ${field}`);
    if (defaults[field] !== undefined && !text(defaults[field])) throw new Error(`Invalid agent ${field}`);
    if (locked(defaults, field) && input[field] !== undefined && input[field] !== defaults[field]) {
      throw new Error(`Agent locks ${field}; remove the conflicting ${field} override`);
    }
  }
  const requested = text(input.model) ?? text(defaults.model);
  let model: Model<Api>;
  let tier: string | undefined;
  let effort: number | undefined;
  let modelSource: SpawnRoute["modelSource"];
  if (requested || locked(defaults, "model")) {
    const ref = !requested || requested === "inherit" ? modelKey(ctx.model) : requested;
    const matches = scopedCandidates(ctx, ref).filter((candidate) =>
      ctx.modelRegistry.getAvailable().some((available) => modelKey(available) === modelKey(candidate)));
    if (matches.length !== 1) throw new Error(`Subagent model '${ref}' is unavailable, outside scope, or ambiguous; use an exact provider/model`);
    model = matches[0];
    // A host ignores injected values for locked fields, so its own reference must be exact.
    if (locked(defaults, "model") && requested && requested !== "inherit" && requested !== modelKey(model)) {
      throw new Error("Locked agent model must use an exact provider/model to guarantee scope");
    }
    modelSource = text(input.model) ? "caller" : "agent";
  } else {
    const result = await policy.select(text(input.prompt) ?? text(input.task) ?? "");
    if (!result) throw new Error("No eligible configured subagent model; selection stopped without unrestricted fallback");
    ({ model, tier, effort } = result);
    modelSource = "bifrost";
  }
  const invalid = policy.validate(model);
  if (invalid) throw new Error(`Subagent ${modelKey(model)}: ${invalid}`);
  const explicitThinking = text(input.thinking) ?? text(defaults.thinking);
  if (locked(defaults, "thinking") && !explicitThinking) throw new Error("Agent locks thinking without a value; configure the locked level explicitly");
  let thinking = explicitThinking;
  let thinkingSource: SpawnRoute["thinkingSource"] = text(input.thinking) ? "caller" : "agent";
  const scopedThinking = ctx.scopedModels?.find((entry) => modelKey(entry.model) === modelKey(model))?.thinkingLevel;
  if (scopedThinking !== undefined) {
    if (thinking !== undefined && thinking !== scopedThinking) throw new Error("Subagent thinking conflicts with the model's scoped thinking level");
    thinking ??= scopedThinking;
    if (!explicitThinking) thinkingSource = "scope";
  }
  if (thinking === undefined) {
    thinking = policy.thinking(text(input.prompt) ?? text(input.task) ?? "", model, tier, effort);
    thinkingSource = thinking === undefined ? "default" : "bifrost";
    thinking ??= policy.defaultThinking;
  }
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error(`Invalid subagent thinking: ${thinking}`);
  const clamped = clampToModel(thinking as ThinkingLevel, model);
  if (clamped.clamped && (explicitThinking !== undefined || locked(defaults, "thinking") || scopedThinking !== undefined)) {
    throw new Error(`Subagent thinking '${thinking}' unsupported by ${modelKey(model)}: ${clamped.reason}`);
  }
  return { model: modelKey(model), thinking: clamped.level, modelSource, thinkingSource, fallback: "stop" };
}
