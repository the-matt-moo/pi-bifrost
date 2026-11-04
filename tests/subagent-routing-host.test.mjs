import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const jiti = createJiti(import.meta.url);
const bifrost = (await jiti.import(join(root, "index.ts"))).default;
const model = (provider, id) => ({ provider, id, name: id, api: "openai-completions", input: ["text"], reasoning: true,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 });
const key = (m) => `${m.provider}/${m.id}`;

it("host: routes spawns once, preserves pins, leaves children and resumes alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-spawn-host-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR, oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = async () => { throw new Error("network disabled in regression test"); };
  const parentModel = model("test", "parent"), cheap = model("test", "cheap"), pinned = model("test", "pinned");
  const available = [parentModel, cheap, pinned];
  writeFileSync(join(dir, "bifrost.json"), JSON.stringify({ enabled: true, silent: true, classifier: { enabled: false }, cache: { enabled: false },
    default: "general", strategy: "first", thinking: { mode: "off" }, models: { general: [key(cheap)] }, reliability: { enabled: true } }));
  const handlers = new Map(), events = new Map(), entries = [], switches = [];
  const pi = { on: (n, fn) => handlers.set(n, fn), registerCommand() {}, registerShortcut() {}, getThinkingLevel: () => "high",
    appendEntry: (customType, data) => entries.push({ customType, data }), setModel: async (m) => { switches.push(key(m)); return true; },
    events: { on: (n, fn) => { events.set(n, fn); return () => events.delete(n); }, emit: (n, d) => events.get(n)?.(d) } };
  bifrost(new Proxy(pi, { get: (obj, k) => obj[k] ?? (() => {}) }));
  const makeCtx = (id) => ({ cwd: dir, model: parentModel, thinkingLevel: "high", hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => id },
    modelRegistry: { find: (p, i) => available.find((m) => m.provider === p && m.id === i), getAvailable: () => available, refresh: async () => {}, getProviderAuth: async () => undefined },
    scopedModels: available.map((m) => ({ model: m })), ui: new Proxy({}, { get: () => () => {} }) });
  const parent = makeCtx("parent");
  try {
    await handlers.get("session_start")({}, parent);
    const call = async (input) => { const result = await handlers.get("tool_call")({ toolName: "subagent", toolCallId: "t", input }, parent); return { result, input }; };

    const pin = await call({ subagent_type: "general-purpose", prompt: "write code", model: "test/pinned", thinking: "low" });
    assert.equal(pin.result, undefined);
    assert.equal(pin.input.model, "test/pinned");
    assert.equal(pin.input.thinking, "low");

    const auto = await call({ subagent_type: "general-purpose", prompt: "hello" });
    assert.equal(auto.input.model, key(cheap), "Bifrost selected from configured routing");
    assert.equal(auto.input.thinking, "medium", "global default, not the parent's high level");
    assert.equal(entries.at(-1).customType, "bifrost-spawn-route");
    assert.equal(entries.at(-1).data.fallback, "stop");

    const bad = await call({ subagent_type: "general-purpose", prompt: "x", model: "test/missing" });
    assert.equal(bad.result.block, true);
    assert.equal(bad.input.model, "test/missing", "a rejected pin is not silently replaced");

    const resume = await call({ resume: "abc", prompt: "continue" });
    assert.equal(resume.result, undefined);
    assert.equal(resume.input.model, undefined);
    assert.deepEqual(switches, [], "spawn routing never switches the parent model");

    // Child: announced by the lifecycle event, then bound.
    events.get("subagents:child:session-created")({ sessionId: "child" });
    const child = makeCtx("child");
    await handlers.get("session_start")({}, child);
    assert.equal(entries.at(-1).customType, "bifrost-child-route");
    assert.deepEqual(await handlers.get("input")({ text: "implement the CAD design", source: "interactive" }, child), { action: "continue" });
    await handlers.get("model_select")({}, child);
    await handlers.get("thinking_level_select")({ level: "xhigh" }, child);
    assert.deepEqual(switches, [], "child prompts are never re-routed");
    events.get("subagents:child:disposed")({ sessionId: "child" });
  } finally {
    await handlers.get("session_shutdown")?.({}, parent);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("host: integrates with pi-subagents registerSpawnHook and preserves existing locked values", async () => {
  const subagentsDir = "C:/Users/Tench/.pi/agent/npm/node_modules/@gotgenes/pi-subagents";
  const { AgentTypeRegistry } = await jiti.import(join(subagentsDir, "src/config/agent-types.ts"));
  const { resolveSpawnConfigWithHook } = await jiti.import(join(subagentsDir, "src/tools/spawn-config.ts"));
  const { publishSubagentsService, unpublishSubagentsService } = await jiti.import(join(subagentsDir, "src/service/service.ts"));

  const dir = mkdtempSync(join(tmpdir(), "bifrost-spawn-hook-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR, oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = async () => { throw new Error("network disabled in regression test"); };
  const parentModel = model("test", "parent"), cheap = model("test", "cheap"), lockedModel = model("test", "locked-model");
  const available = [parentModel, cheap, lockedModel];
  writeFileSync(join(dir, "bifrost.json"), JSON.stringify({ enabled: true, silent: true, classifier: { enabled: false }, cache: { enabled: false },
    default: "general", strategy: "first", thinking: { mode: "off" }, models: { general: [key(cheap)] }, reliability: { enabled: true } }));

  let registeredHook;
  publishSubagentsService({
    spawn: () => "id",
    getRecord: () => undefined,
    listAgents: () => [],
    abort: () => false,
    steer: async () => false,
    resume: async () => ({ kind: "refused", reason: "unknown-agent" }),
    waitForAll: async () => {},
    hasRunning: () => false,
    registerWorkspaceProvider: () => () => {},
    registerSpawnHook: (hook) => { registeredHook = hook; return () => { if (registeredHook === hook) registeredHook = undefined; }; },
  });

  const handlers = new Map(), events = new Map(), entries = [];
  const pi = { on: (n, fn) => handlers.set(n, fn), registerCommand() {}, registerShortcut() {}, getThinkingLevel: () => "high",
    appendEntry: (customType, data) => entries.push({ customType, data }), setModel: async () => true,
    events: { on: (n, fn) => { events.set(n, fn); return () => events.delete(n); }, emit: (n, d) => events.get(n)?.(d) } };
  bifrost(new Proxy(pi, { get: (obj, k) => obj[k] ?? (() => {}) }));

  const modelRegistry = { find: (p, i) => available.find((m) => m.provider === p && m.id === i), getAll: () => available, getAvailable: () => available, refresh: async () => {}, getProviderAuth: async () => undefined };
  const parent = { cwd: dir, model: parentModel, thinkingLevel: "high", hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "parent" },
    modelRegistry, scopedModels: available.map((m) => ({ model: m })), ui: new Proxy({}, { get: () => () => {} }) };

  try {
    await handlers.get("session_start")({}, parent);
    assert.equal(typeof registeredHook, "function", "Bifrost registered pre-spawn hook on SubagentsService");

    // tool_call delegates to the registered pre-spawn hook without mutating caller params up front.
    const rawParams = { subagent_type: "Explore", prompt: "search repo", description: "search" };
    const tcResult = await handlers.get("tool_call")({ toolName: "subagent", toolCallId: "tc-1", input: rawParams }, parent);
    assert.equal(tcResult, undefined);
    assert.equal(rawParams.model, undefined, "tool_call leaves raw params untouched for resolveSpawnConfigWithHook");

    const registry = new AgentTypeRegistry(() => new Map([
      ["LockedReviewer", {
        name: "LockedReviewer",
        description: "Reviewer with locked model and unlocked thinking",
        systemPrompt: "review",
        promptMode: "replace",
        model: key(lockedModel),
        locked: ["model"],
      }],
    ]));

    // 1. Built-in Explore routes via hook (replaces built-in haiku hint with Bifrost selection + default thinking).
    const exploreResolved = await resolveSpawnConfigWithHook(
      rawParams,
      registry,
      { parentModel, modelRegistry },
      { defaultMaxTurns: undefined },
      registeredHook,
      { toolCallId: "tc-1" },
    );
    assert.equal("error" in exploreResolved, false);
    assert.equal(exploreResolved.execution.model.id, "cheap");
    assert.equal(exploreResolved.execution.thinking, "medium");

    // 2. Locked agent model is preserved even if caller passes a conflicting model, while unlocked thinking is filled by hook.
    const lockedResolved = await resolveSpawnConfigWithHook(
      { subagent_type: "LockedReviewer", model: key(cheap), prompt: "review diff", description: "review" },
      registry,
      { parentModel, modelRegistry },
      { defaultMaxTurns: undefined },
      async (ctx) => {
        const res = await registeredHook(ctx);
        // Even if a hook tried to return a different model for a locked field, resolveSpawnConfigWithHook preserves the locked model.
        return { ...res, model: key(cheap) };
      },
      { toolCallId: "tc-2" },
    );
    assert.equal("error" in lockedResolved, false);
    assert.equal(lockedResolved.execution.model.id, "locked-model", "locked model value is preserved");
    assert.equal(lockedResolved.execution.thinking, "medium", "unlocked thinking is supplied by hook");
    assert.ok(lockedResolved.notes.some((n) => n.includes("locks model")), "caller lock discard note preserved");
  } finally {
    await handlers.get("session_shutdown")?.({}, parent);
    unpublishSubagentsService();
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
