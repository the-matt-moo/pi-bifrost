import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { resolveSpawnRoute, loadAgentRoutingDefaults } = await jiti.import("../subagent-routing.ts");
const { isChildSession, noteChildSession, CHILD_ROUTE_ENTRY } = await jiti.import("../child-session.ts");
const model = (id, reasoning = true) => ({ provider: "test", id, reasoning, name: id });
const a = model("alpha"), b = model("beta");
function setup({ scope = [a, b], available = [a, b], scopedThinking, defaultThinking = "medium", recommend = "low" } = {}) {
  const ctx = { model: a, thinkingLevel: "high", scopedModels: scope.map((model) => ({ model, thinkingLevel: scopedThinking })),
    modelRegistry: { getAvailable: () => available, find: (provider, id) => [a, b, ...available].find((m) => m.provider === provider && m.id === id) } };
  let selections = 0, recommendations = 0;
  const policy = { select: async () => { selections++; return { model: b, tier: "coding" }; },
    thinking: () => { recommendations++; return recommend; }, defaultThinking, validate: () => undefined };
  return { ctx, policy, counts: () => [selections, recommendations] };
}

describe("spawn model and thinking resolution", () => {
  it("preserves independent explicit fields and never invokes classifier for a pin", async () => {
    const { ctx, policy, counts } = setup();
    const route = await resolveSpawnRoute({ model: "test/alpha", thinking: "minimal" }, {}, ctx, policy);
    assert.deepEqual(route, { model: "test/alpha", thinking: "minimal", modelSource: "caller", thinkingSource: "caller", fallback: "stop" });
    assert.deepEqual(counts(), [0, 0]);
  });
  it("selects model once but preserves explicit thinking", async () => {
    const { ctx, policy, counts } = setup();
    const route = await resolveSpawnRoute({ thinking: "medium", prompt: "implement feature" }, {}, ctx, policy);
    assert.equal(route.model, "test/beta"); assert.equal(route.thinking, "medium"); assert.deepEqual(counts(), [1, 0]);
  });
  it("uses agent settings before classifier and defaults", async () => {
    const { ctx, policy, counts } = setup();
    const route = await resolveSpawnRoute({}, { model: "test/alpha", thinking: "low" }, ctx, policy);
    assert.equal(route.modelSource, "agent"); assert.equal(route.thinkingSource, "agent"); assert.deepEqual(counts(), [0, 0]);
  });
  it("caller may override unlocked agent defaults", async () => {
    const { ctx, policy } = setup();
    const r = await resolveSpawnRoute({ model: "test/beta", thinking: "off" }, { model: "test/alpha", thinking: "high" }, ctx, policy);
    assert.equal(r.model, "test/beta"); assert.equal(r.thinking, "off");
  });
  for (const locked of [true, ["model", "thinking"], "model, thinking"]) {
    it(`rejects conflicts with agent locks ${JSON.stringify(locked)}`, async () => {
      const { ctx, policy } = setup();
      await assert.rejects(resolveSpawnRoute({ model: "test/beta" }, { model: "test/alpha", thinking: "low", locked }, ctx, policy), /locks model/);
      await assert.rejects(resolveSpawnRoute({ thinking: "high" }, { model: "test/alpha", thinking: "low", locked }, ctx, policy), /locks thinking/);
    });
  }
  it("accepts identical explicit values on locked agents", async () => {
    const { ctx, policy } = setup();
    assert.equal((await resolveSpawnRoute({ model: "test/alpha", thinking: "low" }, { model: "test/alpha", thinking: "low", locked: true }, ctx, policy)).thinking, "low");
  });
  it("fails closed on locked fuzzy references and unspecified locked thinking", async () => {
    const { ctx, policy } = setup();
    await assert.rejects(resolveSpawnRoute({}, { model: "alpha", locked: true }, ctx, policy), /exact provider/);
    await assert.rejects(resolveSpawnRoute({}, { model: "test/alpha", locked: ["thinking"] }, ctx, policy), /without a value/);
  });
  it("validates scope and auth rather than silently replacing a pin", async () => {
    const scoped = setup({ scope: [b] });
    await assert.rejects(resolveSpawnRoute({ model: "test/alpha" }, {}, scoped.ctx, scoped.policy), /outside scope/);
    const authless = setup({ available: [b] });
    await assert.rejects(resolveSpawnRoute({ model: "test/alpha" }, {}, authless.ctx, authless.policy), /unavailable/);
  });
  it("canonicalizes an unambiguous fuzzy model but rejects ambiguity", async () => {
    const { ctx, policy } = setup();
    assert.equal((await resolveSpawnRoute({ model: "alpha" }, {}, ctx, policy)).model, "test/alpha");
    await assert.rejects(resolveSpawnRoute({ model: "test" }, {}, ctx, policy), /ambiguous/);
  });
  it("checks health without selecting an alternative for an explicit pin", async () => {
    const { ctx, policy, counts } = setup(); policy.validate = () => "quota-exhausted";
    await assert.rejects(resolveSpawnRoute({ model: "test/alpha" }, {}, ctx, policy), /quota-exhausted/);
    assert.equal(counts()[0], 0);
  });
  it("uses global default, not parent's high thinking, when automatic thinking is off", async () => {
    const { ctx, policy } = setup({ recommend: undefined }); policy.thinking = () => undefined;
    const route = await resolveSpawnRoute({ model: "test/alpha" }, {}, ctx, policy);
    assert.equal(route.thinking, "medium"); assert.equal(route.thinkingSource, "default");
  });
  it("uses model-scoped thinking as a constraint", async () => {
    const { ctx, policy } = setup({ scopedThinking: "low" });
    assert.equal((await resolveSpawnRoute({}, {}, ctx, policy)).thinkingSource, "scope");
    await assert.rejects(resolveSpawnRoute({ thinking: "high" }, {}, ctx, policy), /conflicts/);
  });
  it("rejects unsupported explicit thinking but clamps inferred thinking", async () => {
    const plain = model("plain", false), { ctx, policy } = setup({ available: [plain], scope: [plain] });
    await assert.rejects(resolveSpawnRoute({ model: "test/plain", thinking: "low" }, {}, ctx, policy), /unsupported/);
    assert.equal((await resolveSpawnRoute({ model: "test/plain" }, {}, ctx, policy)).thinking, "off");
  });
  it("fails closed on missing selections and invalid inputs without mutating input", async () => {
    const { ctx, policy } = setup(); policy.select = async () => null;
    await assert.rejects(resolveSpawnRoute({}, {}, ctx, policy), /No eligible/);
    const input = { model: "test/alpha", thinking: "bogus" };
    await assert.rejects(resolveSpawnRoute(input, {}, ctx, policy), /Invalid subagent thinking/);
    assert.deepEqual(input, { model: "test/alpha", thinking: "bogus" });
    await assert.rejects(resolveSpawnRoute({ model: 7 }, {}, ctx, policy), /Invalid subagent model/);
  });
});

it("loads project agent defaults over global without merging replaced files", () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-agent-defaults-"));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(dir, "global");
  try {
    mkdirSync(join(dir, "global", "agents"), { recursive: true }); mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(dir, "global", "agents", "Review.md"), "---\nmodel: test/alpha\nthinking: high\n---\n");
    writeFileSync(join(dir, ".pi", "agents", "Review.md"), "---\nmodel: test/beta\nlocked: [model]\n---\n");
    const d = loadAgentRoutingDefaults(dir, "review"); assert.equal(d.model, "test/beta"); assert.equal(d.thinking, undefined);
    assert.equal(loadAgentRoutingDefaults(dir, "Explore").model, undefined);
    writeFileSync(join(dir, ".pi", "agents", "Review.md"), "---\nenabled: false\n---\n");
    assert.throws(() => loadAgentRoutingDefaults(dir, "Review"), /disabled/);
    assert.deepEqual(loadAgentRoutingDefaults(dir, "../missing"), {}, "unknown types route as general-purpose");
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); }
});

it("uses lifecycle identity and persisted marker, never mistakes an ordinary fork for a child", () => {
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "child-1", getHeader: () => ({ parentSession: "parent" }), getEntries: () => [] } };
  assert.equal(isChildSession(ctx), false);
  noteChildSession({ sessionId: "child-1" }); assert.equal(isChildSession(ctx), true);
  noteChildSession({ sessionId: "child-1" }, true); assert.equal(isChildSession(ctx), false);
  ctx.sessionManager.getEntries = () => [{ type: "custom", customType: CHILD_ROUTE_ENTRY, data: { owner: "spawn" } }];
  assert.equal(isChildSession(ctx), true);
});
