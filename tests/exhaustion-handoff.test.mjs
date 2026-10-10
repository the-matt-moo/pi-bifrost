import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const jiti = createJiti(import.meta.url);
const bifrost = (await jiti.import(join(root, "index.ts"))).default;
const { isRetryableAssistantError } = await import("@earendil-works/pi-ai");
const model = (provider, id, images = false) => ({ provider, id, name: id, api: "openai-completions", input: images ? ["text", "image"] : ["text"], reasoning: false,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 });
const key = (m) => `${m.provider}/${m.id}`;

async function scenario(options, fn) {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-handoff-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  // Never make credentialed or paid calls, even if the developer has provider environment overrides.
  globalThis.fetch = async () => { throw new Error("network disabled in regression test"); };
  const current = options.current ?? model("anthropic", "opus");
  const native = model("openai-codex", "codex", options.images);
  native.cost.input = native.cost.output = 5; // cheaper OpenRouter must not defeat native-first handoff
  const or = model("openrouter", "anthropic/opus", options.images);
  const fable = model("anthropic", "fable");
  const tier = options.tier ?? "coding";
  const available = options.available ?? [current, or, native, fable];
  const configured = options.configured ?? [current, or, native];
  writeFileSync(join(dir, "bifrost.json"), JSON.stringify({ enabled: true, silent: true, classifier: { enabled: false }, cache: { enabled: false },
    default: "general", strategy: options.strategy ?? "first", subscriptionGuard: options.guard, models: { [tier]: configured.map(key), general: options.general?.map(key) ?? [key(fable)] },
    quotaRouting: { providers: options.quota ?? {} }, reliability: { enabled: true, autoRetry: true, maxAutoRetries: options.max ?? 2 } }));
  const handlers = new Map();
  const sent = [];
  const switches = [];
  const statuses = new Map();
  const branch = options.branch ?? [
    { type: "message", message: { role: "user", content: "Implement the requested fix" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "write-1", toolName: "write", isError: false, content: [{ type: "text", text: "Completed: changed example.ts once" }] } },
  ];
  let ctx;
  const pi = { on: (name, fn) => handlers.set(name, fn), registerCommand: () => {}, getThinkingLevel: () => "off",
    sendUserMessage: (message) => sent.push(message), setModel: async (next) => {
      switches.push(key(next));
      if (options.switchFailure === "throw") throw new Error("switch refused");
      if (options.switchFailure) return false;
      ctx.model = next;
      await handlers.get("model_select")({}, ctx);
      return true;
    } };
  bifrost(new Proxy(pi, { get: (obj, k) => obj[k] ?? (() => {}) }));
  ctx = { model: current, thinkingLevel: "off", hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => branch, getSessionId: () => "fake-session" },
    modelRegistry: { find: (p, id) => available.find((m) => m.provider === p && m.id === id), getAvailable: () => available, refresh: async () => {}, getProviderAuth: async () => undefined },
    scopedModels: (options.scope ?? available).map((model) => ({ model, thinkingLevel: "off" })),
    ui: new Proxy({ setStatus: (name, value) => statuses.set(name, value) }, { get: (obj, k) => obj[k] ?? (() => {}) }) };
  const input = async (images, text = "continue the fix") => handlers.get("input")({ text, source: "interactive", images }, ctx);
  const failure = async (reason = "429 credits_required", content = []) => {
    const message = { role: "assistant", provider: ctx.model.provider, model: ctx.model.id, stopReason: "error", errorMessage: reason, content };
    const replaced = await handlers.get("message_end")({ message }, ctx);
    const finalized = replaced?.message ?? message;
    branch.push({ type: "message", message: finalized });
    await handlers.get("agent_end")({ messages: [finalized] }, ctx);
    return finalized;
  };
  const settle = async (extra = {}) => handlers.get("agent_before_settle")({ outcome: "error", context: { pendingMessages: [], contextMessages: branch.filter((e) => e.message).map((e) => e.message) }, ...extra }, ctx);
  try {
    await handlers.get("session_start")({}, ctx);
    await handlers.get("model_select")({}, ctx); // manual pin
    await fn({ handlers, ctx, input, failure, settle, switches, sent, branch, current, native, or, fable, statuses });
  } finally {
    await handlers.get("session_shutdown")({}, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("exhaustion handoff runtime (fake registry/provider)", { concurrency: 1 }, () => {
  for (const tier of ["quick", "coding"]) it(`hands off ${tier} strictly above 95% session used despite weekly headroom; native precedes configured OpenRouter`, async () => {
    await scenario({ tier, strategy: "cheapest", quota: { anthropic: { sessionRemainingFraction: 0.04, weeklyRemainingFraction: 0.8 } } }, async ({ input, ctx, switches, native, handlers, sent, statuses }) => {
      assert.equal((await input()).action, "continue");
      assert.equal(key(ctx.model), key(native));
      assert.deepEqual(switches, [key(native)]);
      assert.ok(!/pinned/.test(statuses.get("bifrost-state")), "successful self-switch does not re-pin");
      const context = await handlers.get("context")({ messages: [] }, ctx);
      assert.match(context.messages[0].content, /Completed: changed example.ts once/);
      assert.match(context.messages[0].content, /do not repeat completed tool calls/);
      assert.equal(await handlers.get("context")({ messages: [] }, ctx), undefined);
      assert.equal(sent.length, 0);
    });
  });
  for (const tier of ["quick", "coding"]) it(`keeps exactly 95% session used in ${tier}`, async () => {
    await scenario({ tier, quota: { anthropic: { sessionRemainingFraction: 0.05, weeklyRemainingFraction: 0.8 } } }, async ({ input, switches }) => {
      assert.equal((await input()).action, "continue");
      assert.deepEqual(switches, []);
    });
  });
  it("credits_required is terminal before host retries; pinned run continues once with completed context, never replays", async () => {
    await scenario({}, async ({ input, failure, settle, handlers, ctx, native, sent, branch }) => {
      await input();
      const finalized = await failure("429 {\"type\":\"credits_required\"}", [{ type: "text", text: "I already changed the file" }]);
      assert.equal(isRetryableAssistantError(finalized), false);
      const result = await settle();
      assert.equal(result.continue, true);
      assert.equal(key(ctx.model), key(native));
      assert.equal(sent.length, 0);
      assert.equal(result.entries.length, 1);
      assert.ok(!result.entries[0].content.includes("changed example.ts"), "digest is not persisted");
      const injected = await handlers.get("context")({ messages: branch.map((e) => e.message) }, ctx);
      assert.match(injected.messages.at(-1).content, /changed example.ts once/);
      assert.match(injected.messages.at(-1).content, /I already changed the file/);
      assert.equal(await handlers.get("context")({ messages: [] }, ctx), undefined);
      assert.equal(await settle(), undefined, "no failure means no repeated continuation");
    });
  });
  it("tracks pinned/manual runs even when input routing was bypassed", async () => {
    await scenario({}, async ({ handlers, ctx, failure, settle, native, sent }) => {
      await handlers.get("before_agent_start")({ prompt: "finish unfinished work", systemPrompt: "test" }, ctx);
      await failure();
      assert.equal((await settle()).continue, true);
      assert.equal(key(ctx.model), key(native));
      assert.equal(sent.length, 0);
    });
  });
  it("honors explicit new-category user overrides instead of treating them as old-category retries", async () => {
    const target = model("other-native", "manual");
    const current = model("anthropic", "opus");
    await scenario({ current, available: [current, target], general: [target], quota: { anthropic: { sessionRemainingFraction: 0.04 } } }, async ({ input, ctx }) => {
      const result = await input(undefined, "general explain this");
      assert.equal(result.action, "transform");
      assert.equal(key(ctx.model), key(target));
    });
  });
  it("weekly exhaustion is separate from session exhaustion", async () => {
    await scenario({ quota: { anthropic: { weeklyRemainingFraction: 0.01, sessionRemainingFraction: 0.8 } } }, async ({ input, switches, native }) => {
      await input();
      assert.deepEqual(switches, [key(native)]);
    });
  });
  it("subscription guard never redirects outside scope", async () => {
    const current = model("openrouter", "anthropic/opus"), excluded = model("anthropic", "opus");
    await scenario({ current, available: [current, excluded], configured: [current, excluded], scope: [current], guard: { "anthropic/": "anthropic" } }, async ({ switches, ctx }) => {
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
    });
  });
  it("uses configured scoped same-category OpenRouter only when native alternatives are drained", async () => {
    await scenario({ quota: { "openai-codex": { sessionRemainingFraction: 0 } } }, async ({ input, failure, settle, ctx, or }) => {
      await input(); await failure();
      assert.equal((await settle()).continue, true);
      assert.equal(key(ctx.model), key(or));
    });
  });
  it("ultra refuses OpenRouter and never falls into the default category", async () => {
    await scenario({ tier: "ultra", quota: { "openai-codex": { sessionRemainingFraction: 0 } } }, async ({ input, failure, settle, switches, ctx, current }) => {
      await input(); await failure();
      assert.equal(await settle(), undefined);
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
    });
  });
  it("never selects Fable from the wider scope if it is not configured in the current category", async () => {
    const current = model("anthropic", "opus"), fable = model("anthropic", "fable");
    await scenario({ current, available: [current, fable], configured: [current] }, async ({ input, failure, settle, switches }) => {
      await input(); await failure();
      assert.equal(await settle(), undefined);
      assert.deepEqual(switches, []);
    });
  });
  it("does not trust configured models outside Pi scope", async () => {
    const current = model("anthropic", "opus"), next = model("openai-codex", "codex");
    await scenario({ current, configured: [current, next], available: [current, next], scope: [current] }, async ({ input, failure, settle, switches }) => {
      await input(); await failure();
      assert.equal(await settle(), undefined);
      assert.deepEqual(switches, []);
    });
  });
  it("stops exhausted input with no replacement instead of sending it to the old model", async () => {
    const current = model("anthropic", "opus");
    await scenario({ current, configured: [current], quota: { anthropic: { sessionRemainingFraction: 0.04 } } }, async ({ input, switches }) => {
      assert.equal((await input()).action, "handled");
      assert.deepEqual(switches, []);
    });
  });
  for (const switchFailure of [true, "throw"]) it(`does not continue or inject after switch failure (${switchFailure})`, async () => {
    await scenario({ switchFailure }, async ({ input, failure, settle, ctx, current, handlers }) => {
      await input(); await failure();
      assert.equal(await settle(), undefined);
      assert.equal(key(ctx.model), key(current));
      assert.equal(await handlers.get("context")({ messages: [] }, ctx), undefined);
    });
  });
  it("keeps image capability across the handoff", async () => {
    await scenario({ images: true }, async ({ input, failure, settle, ctx }) => {
      await input([{ type: "image", data: "test", mimeType: "image/png" }]); await failure();
      assert.equal((await settle()).continue, true);
      assert.ok(ctx.model.input.includes("image"));
    });
  });
  it("stops when images have no capable replacement", async () => {
    await scenario({}, async ({ input, failure, settle, switches }) => {
      await input([{ type: "image", data: "test", mimeType: "image/png" }]); await failure();
      assert.equal(await settle(), undefined);
      assert.deepEqual(switches, []);
    });
  });
  it("stops on an aborted host boundary or competing queued input", async () => {
    for (const extra of [{ outcome: "aborted" }, { context: { pendingMessages: [{}], contextMessages: [] } }]) {
      await scenario({}, async ({ input, failure, settle, switches }) => {
        await input(); await failure();
        assert.equal(await settle(extra), undefined);
        assert.deepEqual(switches, []);
      });
    }
  });
  it("stops when a tool call has no finalized result", async () => {
    await scenario({}, async ({ input, failure, settle, switches }) => {
      await input(); await failure("429 credits_required", [{ type: "toolCall", id: "uncertain", name: "write", arguments: {} }]);
      assert.equal(await settle(), undefined);
      assert.deepEqual(switches, []);
    });
  });
  it("does not resurrect omitted raw branch content in the ephemeral digest", async () => {
    await scenario({}, async ({ input, ctx, failure, settle, branch, handlers }) => {
      await input();
      branch.push({ type: "message", message: { role: "user", content: "omitted raw branch text" } });
      await failure();
      ctx.sessionManager.buildSessionProjection = () => ({ messages: branch.filter((e) => e.message?.content !== "omitted raw branch text").map((e) => e.message) });
      assert.equal((await settle()).continue, true);
      const injected = await handlers.get("context")({ messages: [] }, ctx);
      assert.ok(!injected.messages[0].content.includes("omitted raw branch text"));
      assert.match(injected.messages[0].content, /changed example.ts once/);
    });
  });
  it("normal transient 429 remains host-retryable, then continues same category at final boundary", async () => {
    await scenario({}, async ({ input, failure, settle }) => {
      await input(); const finalized = await failure("429 temporarily rate limited");
      assert.equal(isRetryableAssistantError(finalized), true);
      assert.equal((await settle()).continue, true);
    });
  });
  it("bounds continuation count even when replacement also fails", async () => {
    await scenario({ max: 1 }, async ({ input, failure, settle, switches }) => {
      await input(); await failure(); assert.equal((await settle()).continue, true);
      await failure(); assert.equal(await settle(), undefined);
      assert.equal(switches.length, 1);
    });
  });
});
