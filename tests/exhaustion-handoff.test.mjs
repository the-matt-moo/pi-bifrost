import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
  globalThis.fetch = options.fetch ?? (async () => { throw new Error("network disabled in regression test"); });
  const current = options.current ?? model("anthropic", "opus");
  const native = model("openai-codex", "codex", options.images);
  native.cost.input = native.cost.output = 5; // cheaper OpenRouter must not defeat native-first handoff
  const or = model("openrouter", "anthropic/opus", options.images);
  const fable = model(options.fableProvider ?? "anthropic", "fable");
  const tier = options.tier ?? "coding";
  const available = options.available ?? [current, or, native, fable];
  const configured = options.configured ?? [current, or, native];
  writeFileSync(join(dir, "bifrost.json"), JSON.stringify({ enabled: true, silent: true, classifier: options.classifier ?? { enabled: false }, topicRouting: options.topicRouting, cache: { enabled: false },
    default: "general", strategy: options.strategy ?? "first", categoryStrategies: options.categoryStrategies,
    subscriptionGuard: options.guard, rules: options.rules, thinking: options.thinking, keys: options.keys,
    models: { [tier]: configured.map(key), general: options.general?.map(key) ?? [key(fable)], ...options.models },
    quotaRouting: { providers: options.quota ?? {} }, reliability: { enabled: true, autoRetry: true, maxAutoRetries: options.max ?? 2 } }));
  const handlers = new Map();
  const sent = [];
  const switches = [];
  const thinkingSets = [];
  const commands = new Map();
  const shortcuts = new Map();
  let thinking = "off";
  const statuses = new Map();
  const branch = options.branch ?? [
    { type: "message", message: { role: "user", content: "Implement the requested fix" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "write-1", toolName: "write", isError: false, content: [{ type: "text", text: "Completed: changed example.ts once" }] } },
  ];
  let ctx;
  const pi = { on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command),
    registerShortcut: (k, shortcut) => shortcuts.set(k, shortcut), getThinkingLevel: () => thinking,
    setThinkingLevel: (level) => { thinkingSets.push(level); thinking = level; void handlers.get("thinking_level_select")({ level }, ctx); },
    sendUserMessage: (message) => sent.push(message), setModel: async (next) => {
      switches.push(key(next));
      if (typeof options.switchFailure === "function") return options.switchFailure({ next, ctx, handlers, commands });
      if (options.switchFailure === "throw") throw new Error("switch refused");
      if (options.switchFailure) return false;
      ctx.model = next;
      await handlers.get("model_select")({}, ctx);
      return true;
    } };
  bifrost(new Proxy(pi, { get: (obj, k) => obj[k] ?? (() => {}) }));
  ctx = { model: current, thinkingLevel: "off", hasUI: options.hasUI ?? false, isIdle: () => true,
    sessionManager: { getBranch: () => branch, getSessionId: () => "fake-session" },
    modelRegistry: { find: (p, id) => available.find((m) => m.provider === p && m.id === id), getAvailable: () => available, refresh: async () => {}, getProviderAuth: options.providerAuth ?? (async () => undefined) },
    scopedModels: (options.scope ?? available).map((model) => ({ model, thinkingLevel: "off" })),
    ui: new Proxy({ setStatus: (name, value) => statuses.set(name, value), theme: { fg: (_color, text) => text }, ...(options.select ? { select: options.select } : {}) }, { get: (obj, k) => obj[k] ?? (() => {}) }) };
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
    if (options.manualPin !== false) await handlers.get("model_select")({}, ctx); // manual pin
    await fn({ handlers, ctx, input, failure, settle, switches, sent, branch, current, native, or, fable, statuses, dir,
      thinkingSets, commands, shortcuts, thinkingLevel: () => thinking,
      // Host-side level drift without a thinking_level_select event (no manual thinking pin).
      hostThinking: (level) => { thinking = level; },
      manualThinking: async (level) => { thinking = level; await handlers.get("thinking_level_select")({ level }, ctx); } });
  } finally {
    await handlers.get("session_shutdown")({}, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("exhaustion handoff runtime (fake registry/provider)", { concurrency: 1 }, () => {
  for (const tier of ["quick", "coding"]) it(`hands off ${tier} strictly above 95% session used despite weekly headroom; native precedes configured OpenRouter`, async () => {
    await scenario({ tier, strategy: "cheapest", fableProvider: "other-native", quota: { anthropic: { sessionRemainingFraction: 0.04, weeklyRemainingFraction: 0.8 } } }, async ({ input, ctx, switches, native, handlers, sent }) => {
      assert.equal((await input()).action, "continue");
      assert.equal(key(ctx.model), key(native));
      assert.deepEqual(switches, [key(native)]);
      assert.equal((await input(undefined, "explain sourdough starter feeding schedule")).action, "continue");
      assert.deepEqual(switches, [key(native)], "the next prompt keeps the handoff replacement");
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
  it("tracks explicit user runs even when input routing was bypassed", async () => {
    await scenario({}, async ({ handlers, ctx, failure, settle, native, sent }) => {
      await handlers.get("before_agent_start")({ messageType: "user", prompt: "finish unfinished work", systemPrompt: "test" }, ctx);
      await failure();
      assert.equal((await settle()).continue, true);
      assert.equal(key(ctx.model), key(native));
      assert.equal(sent.length, 0);
    });
  });
  it("tracks custom-triggered frontier runs without user retry context", async () => {
    await scenario({ tier: "frontier" }, async ({ handlers, ctx, failure, settle, switches, sent, dir }) => {
      const prepared = await handlers.get("before_agent_start")({
        messageType: "custom",
        message: { role: "custom", customType: "test-trigger", content: "continue", display: false, timestamp: 1 },
        systemPrompt: "test",
      }, ctx);
      assert.match(prepared.systemPrompt, /^test\n\nBifrost frontier role:/);
      await failure();
      assert.equal(await settle(), undefined);
      assert.deepEqual(switches, []);
      assert.equal(sent.length, 0);
      assert.equal(await handlers.get("context")({ messages: [] }, ctx), undefined);
      const reliability = JSON.parse(readFileSync(join(dir, "bifrost-reliability.json"), "utf8"));
      assert.equal(reliability.models[key(ctx.model)].lastFailureSource, "agent_settled");
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
    await scenario({ switchFailure }, async ({ input, failure, settle, ctx, current, handlers, switches, sent }) => {
      await input(); await failure();
      assert.equal(await settle(), undefined);
      assert.equal(key(ctx.model), key(current));
      assert.equal(await handlers.get("context")({ messages: [] }, ctx), undefined);
      const failedSwitches = switches.length;
      assert.equal((await input(undefined, "explain sourdough starter feeding schedule")).action, "continue");
      assert.equal(key(ctx.model), key(current), "failed fallback keeps the old pin");
      assert.equal(switches.length, failedSwitches, "failed fallback does not trigger unrelated rerouting");
      assert.equal(sent.length, 0, "failed fallback never replays the prompt");
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

describe("sticky routed configuration (fake registry/provider)", { concurrency: 1 }, () => {
  const reasoning = (provider, id) => ({ ...model(provider, id), reasoning: true });
  const sticky = (extra = {}) => {
    const current = reasoning("anthropic", "opus");
    const writer = reasoning("writer", "prose");
    return { current, writer, options: { manualPin: false, current, available: [current, writer], configured: [current],
      models: { writing: [key(writer)] }, general: [writer], thinking: { mode: "apply" }, categoryStrategies: { coding: "first", writing: "first" },
      rules: [{ pattern: "\\bcode\\b", model: "coding" }, { pattern: "\\bpoem\\b", model: "writing" }], ...extra } };
  };

  it("pins the first routed model and thinking even when already active; later unrelated topics keep both without rerouting", async () => {
    const { current, options } = sticky();
    await scenario(options, async ({ input, ctx, switches, thinkingSets, thinkingLevel }) => {
      assert.equal((await input(undefined, "fix the code in the parser module")).action, "continue");
      assert.equal(key(ctx.model), key(current));
      const level = thinkingLevel();
      const sets = thinkingSets.length;
      assert.ok(sets > 0, "initial route applies thinking");
      for (const text of ["write a poem about sourdough starter", "plan quarterly budget spreadsheet formulas"]) {
        assert.equal((await input(undefined, text)).action, "continue");
      }
      assert.deepEqual(switches, [], "pinned prompts must not reroute");
      assert.equal(key(ctx.model), key(current));
      assert.equal(thinkingLevel(), level);
      assert.equal(thinkingSets.length, sets, "pinned prompts must not recompute thinking");
    });
  });

  it("manual model and thinking choices stay sticky until command unpin resumes full routing", async () => {
    const { current, writer, options } = sticky();
    await scenario(options, async ({ input, ctx, handlers, commands, switches, thinkingSets, thinkingLevel, manualThinking }) => {
      await input(undefined, "fix the code in the parser module");
      ctx.model = writer;
      await handlers.get("model_select")({}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await manualThinking("high");
      await input(undefined, "fix the code in a different subsystem");
      assert.equal(key(ctx.model), key(writer));
      assert.equal(thinkingLevel(), "high");
      assert.deepEqual(switches, []);

      const before = thinkingSets.length;
      await commands.get("bifrost").handler("unpin", ctx);
      await input(undefined, "code");
      assert.equal(key(ctx.model), key(current));
      assert.ok(thinkingSets.length > before, "unpin resumes automatic thinking");
    });
  });

  for (const [mode, keyName, binding] of [["off", "unpin", "ctrl+delete"], ["advisory", "toggle", "ctrl+p"]]) {
    it(`the configured ${keyName} shortcut preserves explicit ${mode} thinking mode while releasing both locks`, async () => {
      const { writer, options } = sticky({ thinking: { mode }, keys: { [keyName]: binding }, hasUI: true });
      await scenario(options, async ({ input, ctx, shortcuts, switches, thinkingSets, manualThinking, statuses }) => {
        await input(undefined, "fix the code in the parser module");
        await manualThinking("high");
        await shortcuts.get(binding).handler(ctx);
        assert.doesNotMatch(statuses.get("bifrost-state"), /think:pinned/, "thinking lock is released");
        const before = thinkingSets.length;
        await input(undefined, "writing draft release notes");
        assert.equal(key(ctx.model), key(writer), "model lock is released");
        assert.deepEqual(switches, [key(writer)], "routing resumes on the next prompt");
        assert.equal(thinkingSets.length, before, `${mode} mode remains non-applying after thinking lock release`);
      });
    });
  }

  it("the configured unpin shortcut resumes model and thinking routing", async () => {
    const { writer, options } = sticky({ keys: { unpin: "ctrl+delete" } });
    await scenario(options, async ({ input, ctx, shortcuts, switches, thinkingSets }) => {
      await input(undefined, "fix the code in the parser module");
      const before = thinkingSets.length;
      await shortcuts.get("ctrl+delete").handler(ctx);
      await input(undefined, "writing draft release notes");
      assert.equal(key(ctx.model), key(writer));
      assert.deepEqual(switches, [key(writer)]);
      assert.ok(thinkingSets.length > before, "shortcut unpin resumes automatic thinking");
    });
  });

  it("an explicit tier override replaces the sticky configuration until manually unpinned", async () => {
    const { current, writer, options } = sticky();
    await scenario(options, async ({ input, ctx, switches, thinkingSets }) => {
      await input(undefined, "fix the code in the parser module");
      const override = await input(undefined, "writing draft release notes for the change");
      assert.equal(override.action, "transform");
      assert.equal(key(ctx.model), key(writer));
      const sets = thinkingSets.length;
      await input(undefined, "fix the code in a different subsystem");
      assert.equal(key(ctx.model), key(writer));
      assert.deepEqual(switches, [key(writer)]);
      assert.equal(thinkingSets.length, sets, "replacement thinking remains sticky");
      assert.notEqual(key(ctx.model), key(current));
    });
  });
});

describe("opt-in topic routing (fake Jev transport, no network)", { concurrency: 1 }, () => {
  const reasoning = (provider, id) => ({ ...model(provider, id), reasoning: true });
  const answer = (choice, confidence) => ({ answers: { topic: { type: "choice", choice, confidence, probabilities: { continue: 0.5, switch: 0.5 } } } });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  // Queue items: a JSON body, { status } for HTTP failure, an Error to throw, or a function returning a response promise.
  function fakeJev(queue) {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
      const next = queue.shift();
      if (typeof next === "function") return next();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("unexpected Jev call");
      return { ok: !next.status, status: next.status ?? 200, json: async () => next };
    };
    return { calls, fetch };
  }
  const JEV = { enabled: false, model: "openrouter/~typesafe/jev-latest", fallbackModels: [], timeoutMs: 50, maxAttempts: 2 };
  const setup = (queue = [], extra = {}) => {
    const current = reasoning("anthropic", "opus");
    const writer = reasoning("writer", "prose");
    const native = reasoning("openai-codex", "codex");
    const jev = fakeJev(queue);
    return { current, writer, native, jev, options: { manualPin: false, current, available: [current, writer], configured: [current],
      models: { writing: [key(writer)] }, general: [writer], thinking: { mode: "apply" }, categoryStrategies: { coding: "first", writing: "first" },
      rules: [{ pattern: "\\bcode\\b", model: "coding" }, { pattern: "\\bpoem\\b", model: "writing" }],
      // Ordinary classifier stays off: topicRouting.enabled alone permits Jev topic calls.
      classifier: JEV, topicRouting: { enabled: true }, fetch: jev.fetch,
      providerAuth: async (provider) => provider === "openrouter" ? { auth: { apiKey: "fake-test-key" }, env: {} } : undefined,
      ...extra } };
  };
  const START = "fix the code in the parser module";
  const POEM = "write a poem about sourdough starter";

  it("is off unless explicitly enabled, even with Jev and auth configured", async () => {
    const { current, jev, options } = setup([], { topicRouting: undefined });
    await scenario(options, async ({ input, ctx, switches }) => {
      await input(undefined, START);
      await input(undefined, POEM);
      assert.equal(jev.calls.length, 0);
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
    });
  });

  it("confident continuation keeps model and thinking for a related prompt with different vocabulary; request is one bounded Choice", async () => {
    const { current, jev, options } = setup([answer("continue", 0.97)]);
    await scenario(options, async ({ input, ctx, switches, thinkingSets, thinkingLevel, hostThinking }) => {
      await input(undefined, START);
      hostThinking("xhigh");
      const sets = thinkingSets.length;
      const long = `document the tokenizer error messages ${"x".repeat(6000)}`;
      assert.equal((await input(undefined, long)).action, "continue");
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
      assert.equal(thinkingLevel(), "xhigh");
      assert.equal(thinkingSets.length, sets, "continuation must not recompute thinking");
      const [call] = jev.calls;
      assert.equal(call.url, "https://openrouter.ai/api/alpha/decisions");
      assert.equal(call.auth, "Bearer fake-test-key");
      assert.deepEqual(Object.keys(call.body.questions), ["topic"]);
      assert.equal(call.body.questions.topic.type, "choice");
      assert.deepEqual(Object.keys(call.body.questions.topic.criteria), ["continue", "switch"]);
      const state = JSON.parse(call.body.state);
      assert.deepEqual(state.earlierUserPrompts, [START]);
      assert.ok(state.currentUserPrompt.length < 4100, "current prompt is bounded");
      assert.ok(!call.body.state.includes("Completed: changed example.ts"), "no transcript or tool output");
    });
  });

  it("confident independent task reroutes, applies thinking, and becomes the new automatic pin", async () => {
    const { writer, jev, options } = setup([answer("switch", 0.95), answer("continue", 0.99)]);
    await scenario(options, async ({ input, ctx, switches, thinkingSets, hostThinking }) => {
      await input(undefined, START);
      hostThinking("xhigh");
      const sets = thinkingSets.length;
      assert.equal((await input(undefined, POEM)).action, "continue");
      assert.equal(key(ctx.model), key(writer));
      assert.deepEqual(switches, [key(writer)]);
      assert.ok(thinkingSets.length > sets, "rerouted prompt gets fresh thinking");
      await input(undefined, "make the second stanza rhyme");
      assert.equal(jev.calls.length, 2, "new pin stays automatic and eligible");
      assert.deepEqual(JSON.parse(jev.calls[1].body.state).earlierUserPrompts, [POEM], "history re-anchors on the new task");
      assert.deepEqual(switches, [key(writer)]);
    });
  });

  it("a switch that routes to the already-active model re-pins in place without a model switch", async () => {
    const { current, jev, options } = setup([answer("switch", 0.95), answer("continue", 0.99)]);
    await scenario(options, async ({ input, ctx, switches }) => {
      await input(undefined, START);
      await input(undefined, "fix the code in the billing exporter");
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
      await input(undefined, "and add tests");
      assert.deepEqual(JSON.parse(jev.calls[1].body.state).earlierUserPrompts, ["fix the code in the billing exporter"]);
    });
  });

  for (const choice of ["continue", "switch"]) {
    it(`low-confidence ${choice}: confirm re-evaluates; cancel, keep, and no UI keep the pin`, async () => {
      for (const [hasUI, pick, rerouted] of [[true, "Re-evaluate routing", true], [true, undefined, false], [true, "Keep current route", false], [false, "Re-evaluate routing", false]]) {
        const asked = [];
        const { current, writer, options } = setup([answer(choice, 0.6)], { hasUI, select: async (_title, items) => { asked.push(items); return pick; } });
        await scenario(options, async ({ input, ctx, switches, thinkingSets, hostThinking }) => {
          await input(undefined, START);
          hostThinking("xhigh");
          const sets = thinkingSets.length;
          assert.equal((await input(undefined, POEM)).action, "continue");
          assert.equal(key(ctx.model), key(rerouted ? writer : current));
          assert.deepEqual(switches, rerouted ? [key(writer)] : []);
          if (!rerouted) assert.equal(thinkingSets.length, sets);
          assert.deepEqual(asked, hasUI ? [["Keep current route", "Re-evaluate routing"]] : [], "no UI never asks");
        });
      }
    });
  }

  it("a low-confidence answer in a child session keeps the pin without asking", async () => {
    const asked = [];
    const { current, options } = setup([answer("switch", 0.6)], { hasUI: true, select: async () => { asked.push(1); return "Re-evaluate routing"; } });
    const old = process.env.PI_SUBAGENT_RUN_ID;
    process.env.PI_SUBAGENT_RUN_ID = "topic-test";
    try {
      await scenario(options, async ({ input, ctx, switches }) => {
        await input(undefined, START);
        await input(undefined, POEM);
        assert.deepEqual(switches, []);
        assert.equal(key(ctx.model), key(current));
        assert.deepEqual(asked, []);
      });
    } finally {
      if (old === undefined) delete process.env.PI_SUBAGENT_RUN_ID; else process.env.PI_SUBAGENT_RUN_ID = old;
    }
  });

  it("transport errors, HTTP errors, malformed answers, timeouts, and missing credentials keep the pin without asking", async () => {
    const hang = () => new Promise(() => {});
    const cases = [
      [new Error("offline")], [{ status: 500 }], [{}], [{ answers: { topic: null } }],
      [answer("maybe", 0.99)], [answer("switch", Number.NaN)], [answer("switch", 1.5)], [answer("switch", -0.1)], [answer("switch", null)],
      [{ answers: { topic: { type: "choice", choice: "switch", probabilities: { switch: 0.99 } } } }],
      [{ answers: { topic: { type: "noul", choice: "switch", confidence: 0.99 } } }],
      [hang],
    ];
    for (const queue of cases) {
      const asked = [];
      const { current, jev, options } = setup(queue, { hasUI: true, select: async () => { asked.push(1); return "Re-evaluate routing"; } });
      await scenario(options, async ({ input, ctx, switches }) => {
        await input(undefined, START);
        const started = Date.now();
        assert.equal((await input(undefined, POEM)).action, "continue");
        assert.ok(Date.now() - started < 2000, "bounded by classifier.timeoutMs");
        assert.equal(jev.calls.length, 1);
        assert.deepEqual(switches, []);
        assert.equal(key(ctx.model), key(current));
        assert.deepEqual(asked, [], "failures never ask");
      });
    }
    const { current, jev, options } = setup([], { providerAuth: async () => undefined });
    await scenario(options, async ({ input, ctx, switches }) => {
      await input(undefined, START);
      await input(undefined, POEM);
      assert.equal(jev.calls.length, 0, "no credentials, no call");
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
    });
  });

  it("an invalid configured threshold falls back to 0.90", async () => {
    for (const confidenceThreshold of [1.5, -1, "high"]) {
      const { current, options } = setup([answer("switch", 0.89)], { topicRouting: { enabled: true, confidenceThreshold } });
      await scenario(options, async ({ input, ctx, switches }) => {
        await input(undefined, START);
        await input(undefined, POEM);
        assert.deepEqual(switches, [], "0.89 is below the 0.90 default; no UI keeps");
        assert.equal(key(ctx.model), key(current));
      });
    }
    const { writer, options } = setup([answer("switch", 0.6)], { topicRouting: { enabled: true, confidenceThreshold: 0.5 } });
    await scenario(options, async ({ input, ctx }) => {
      await input(undefined, START);
      await input(undefined, POEM);
      assert.equal(key(ctx.model), key(writer), "a valid lower threshold is honored");
    });
  });

  it("manual pins and explicit overrides are exempt from topic checks", async () => {
    let { jev, options } = setup([]);
    await scenario({ ...options, manualPin: true }, async ({ input, switches }) => {
      await input(undefined, POEM);
      assert.deepEqual(switches, []);
    });
    assert.equal(jev.calls.length, 0, "/model pin");
    for (const act of [
      async ({ commands, ctx }) => commands.get("bifrost").handler("pin", ctx),
      async ({ shortcuts, ctx }) => shortcuts.get("ctrl+k").handler(ctx),
      async ({ shortcuts, ctx }) => { await shortcuts.get("ctrl+p").handler(ctx); await shortcuts.get("ctrl+p").handler(ctx); },
    ]) {
      ({ jev, options } = setup([], { keys: { pin: "ctrl+k", toggle: "ctrl+p" } }));
      await scenario(options, async (t) => {
        await t.input(undefined, START);
        await act(t);
        await t.input(undefined, POEM);
        assert.deepEqual(t.switches, []);
      });
      assert.equal(jev.calls.length, 0, "manual pin command/shortcut");
    }
    ({ jev, options } = setup([]));
    await scenario(options, async ({ input, ctx, switches, commands, handlers, sent }) => {
      await input(undefined, START);
      assert.equal((await input(undefined, "writing draft release notes")).action, "transform");
      await input(undefined, "fix the code in a different subsystem");
      await commands.get("coding").handler("fix the code again", ctx);
      await handlers.get("input")({ text: sent.at(-1), source: "extension" }, ctx);
      await input(undefined, POEM);
      assert.equal(switches.length, 2, "only the explicit overrides switched");
    });
    assert.equal(jev.calls.length, 0, "inline and slash tier overrides");
  });

  it("quota guard runs before the topic check and handoffs inherit pin origin", async () => {
    const quota = { anthropic: { sessionRemainingFraction: 0.04 } };
    const withNative = (s) => {
      s.options.available = [s.current, s.writer, s.native];
      s.options.configured = [s.current, s.native];
      return s;
    };
    // Unpinned exhaustion handoff creates an automatic pin.
    let s = withNative(setup([answer("continue", 0.99)], { quota }));
    await scenario(s.options, async ({ input, ctx, switches }) => {
      await input(undefined, START);
      assert.equal(s.jev.calls.length, 0, "exhaustion handoff precedes any topic call");
      assert.equal(key(ctx.model), key(s.native));
      await input(undefined, POEM);
      assert.equal(s.jev.calls.length, 1, "auto origin after handoff");
      assert.deepEqual(JSON.parse(s.jev.calls[0].body.state).earlierUserPrompts, [START]);
      assert.deepEqual(switches, [key(s.native)]);
    });
    // An automatic pin replaced by a provider-error handoff stays automatic.
    s = withNative(setup([answer("continue", 0.99)]));
    await scenario(s.options, async ({ input, failure, settle, ctx }) => {
      await input(undefined, START);
      await failure();
      assert.equal((await settle()).continue, true);
      assert.equal(key(ctx.model), key(s.native));
      await input(undefined, POEM);
      assert.equal(s.jev.calls.length, 1);
    });
    // A manual pin replaced by a quota handoff stays manual.
    s = withNative(setup([], { quota, manualPin: true }));
    await scenario(s.options, async ({ input, ctx }) => {
      await input(undefined, START);
      assert.equal(key(ctx.model), key(s.native));
      await input(undefined, POEM);
      assert.equal(s.jev.calls.length, 0, "manual origin survives the handoff");
    });
  });

  for (const switchFailure of [true, "throw"]) it(`a failed reroute keeps the old pin and never replays (${switchFailure})`, async () => {
    const { current, writer, jev, options } = setup([answer("switch", 0.95), answer("continue", 0.99)], { switchFailure });
    await scenario(options, async ({ input, ctx, switches, sent }) => {
      await input(undefined, START);
      assert.equal((await input(undefined, POEM)).action, "continue", "prompt continues on the old pin");
      assert.deepEqual(switches, [key(writer)]);
      assert.equal(key(ctx.model), key(current));
      await input(undefined, "make it rhyme");
      assert.equal(jev.calls.length, 2, "old automatic pin is still in force");
      assert.deepEqual(switches, [key(writer)]);
      assert.equal(sent.length, 0);
    });
  });

  it("a reroute with no healthy candidate keeps the old pin", async () => {
    const { current, options } = setup([answer("switch", 0.95)]);
    await scenario({ ...options, scope: [current] }, async ({ input, ctx, switches }) => {
      await input(undefined, START);
      assert.equal((await input(undefined, POEM)).action, "continue");
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
    });
  });

  for (const [label, act] of [
    ["a manual re-pin of the same model", async ({ commands, ctx }) => commands.get("bifrost").handler("pin", ctx)],
    ["a manual /model change", async ({ handlers, ctx, other }) => { ctx.model = other; await handlers.get("model_select")({}, ctx); }],
    ["a manual thinking change", async ({ manualThinking }) => manualThinking("high")],
    ["unpin", async ({ commands, ctx }) => commands.get("bifrost").handler("unpin", ctx)],
  ]) it(`a delayed Jev result is dropped after ${label}`, async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const delayed = () => gate.then(() => ({ ok: true, status: 200, json: async () => answer("switch", 0.99) }));
    const other = reasoning("other", "manual");
    const { current, jev, options } = setup([delayed], { classifier: { ...JEV, timeoutMs: 2000 } });
    options.available = [...options.available, other];
    await scenario(options, async (t) => {
      await t.input(undefined, START);
      const pending = t.input(undefined, POEM);
      while (jev.calls.length === 0) await tick();
      await act({ ...t, other });
      release();
      assert.equal((await pending).action, "continue");
      assert.deepEqual(t.switches, [], "no topic route applied");
      assert.equal(key(t.ctx.model), label === "a manual /model change" ? key(other) : key(current));
    });
  });

  it("a manual pin made while re-evaluation classifies wins over the topic route", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const category = (choice) => ({ answers: { category: { type: "choice", choice, confidence: 0.99 } } });
    const delayed = () => gate.then(() => ({ ok: true, status: 200, json: async () => category("writing") }));
    const { current, jev, options } = setup([category("coding"), answer("switch", 0.99), delayed], { classifier: { ...JEV, enabled: true, timeoutMs: 2000 } });
    await scenario(options, async ({ input, ctx, switches, commands }) => {
      await input(undefined, START);
      const pending = input(undefined, POEM);
      while (jev.calls.length < 3) await tick();
      assert.deepEqual(jev.calls.map((call) => Object.keys(call.body.questions)[0]), ["category", "topic", "category"]);
      await commands.get("bifrost").handler("pin", ctx);
      release();
      assert.equal((await pending).action, "continue");
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
    });
  });

  it("an explicit same-tier override that forces a quota handoff becomes a manual pin", async () => {
    const s = setup([answer("switch", 0.99)], { quota: { anthropic: { sessionRemainingFraction: 0.04 } } });
    s.options.available = [s.current, s.writer, s.native];
    s.options.configured = [s.current, s.native];
    await scenario(s.options, async ({ input, ctx }) => {
      assert.equal((await input(undefined, "coding fix the parser")).action, "transform");
      assert.equal(key(ctx.model), key(s.native));
      await input(undefined, POEM);
      assert.equal(s.jev.calls.length, 0, "manual override pin is never topic-checked");
      assert.equal(key(ctx.model), key(s.native));
    });
  });

  it("a handoff after unpin starts fresh topic history instead of inheriting the old anchor", async () => {
    const s = setup([answer("continue", 0.99), answer("continue", 0.99)]);
    s.options.available = [s.current, s.writer, s.native];
    s.options.configured = [s.current, s.native];
    await scenario(s.options, async ({ input, failure, settle, ctx, commands }) => {
      await input(undefined, START);
      await input(undefined, "second step");
      await commands.get("bifrost").handler("unpin", ctx);
      await failure();
      assert.equal((await settle()).continue, true);
      assert.equal(key(ctx.model), key(s.native));
      await input(undefined, POEM);
      assert.deepEqual(JSON.parse(s.jev.calls[1].body.state).earlierUserPrompts, ["second step"]);
    });
  });

  it("topic history sent to Jev is clipped once to the 1,000-character bound", async () => {
    const s = setup([answer("continue", 0.99)]);
    await scenario(s.options, async ({ input }) => {
      await input(undefined, `fix the code ${"a".repeat(3000)}`);
      await input(undefined, POEM);
      const [anchorPrompt] = JSON.parse(s.jev.calls[0].body.state).earlierUserPrompts;
      assert.ok(anchorPrompt.length <= 1000);
      assert.equal(anchorPrompt.split("[middle omitted]").length, 2, "clipped once, not twice");
    });
  });

  it("a failed topic switch fails closed when the host model changed during the switch", async () => {
    const other = reasoning("other", "manual");
    const s = setup([answer("switch", 0.99)], { switchFailure: async ({ ctx }) => { ctx.model = other; return false; } });
    s.options.available = [...s.options.available, other];
    await scenario(s.options, async ({ input, ctx, switches }) => {
      await input(undefined, START);
      assert.equal((await input(undefined, POEM)).action, "handled");
      assert.deepEqual(switches, [key(s.writer)]);
      assert.equal(key(ctx.model), key(other), "host choice preserved");
    });
  });

  for (const [label, manual] of [
    ["/bifrost pin", async ({ ctx, commands }) => commands.get("bifrost").handler("pin", ctx)],
    ["/model", async ({ ctx, handlers, other }) => { ctx.model = other; await handlers.get("model_select")({}, ctx); }],
  ]) it(`a manual ${label} during a successful topic switch is not re-autopinned`, async () => {
    const other = reasoning("other", "manual");
    const s = setup([answer("switch", 0.99)], { switchFailure: async (t) => {
      t.ctx.model = t.next;
      await t.handlers.get("model_select")({}, t.ctx); // Bifrost's own selection event
      await manual({ ...t, other });
      return true;
    } });
    s.options.available = [...s.options.available, other];
    await scenario(s.options, async ({ input, ctx, thinkingSets, hostThinking }) => {
      await input(undefined, START);
      hostThinking("xhigh");
      const sets = thinkingSets.length;
      assert.equal((await input(undefined, POEM)).action, "continue");
      assert.equal(key(ctx.model), label === "/model" ? key(other) : key(s.writer));
      assert.equal(thinkingSets.length, sets, "no topic thinking applied over the manual choice");
      await input(undefined, "another unrelated thing");
      assert.equal(s.jev.calls.length, 1, "manual pin is kept, not replaced by an automatic one");
    });
  });

  it("a manual pin made during the low-confidence question wins over Re-evaluate", async () => {
    let commandsRef, ctxRef;
    const { current, options } = setup([answer("switch", 0.5)], { hasUI: true,
      select: async () => { await commandsRef.get("bifrost").handler("pin", ctxRef); return "Re-evaluate routing"; } });
    await scenario(options, async ({ input, ctx, switches, commands }) => {
      commandsRef = commands; ctxRef = ctx;
      await input(undefined, START);
      await input(undefined, POEM);
      assert.deepEqual(switches, []);
      assert.equal(key(ctx.model), key(current));
    });
  });
});
