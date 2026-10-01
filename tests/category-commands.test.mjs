// /<category> slash commands force that category and strip the command prefix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "bifrost-cmd-"));
writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
  classifier: { enabled: false },
  models: { coding: ["p/c"], frontier: ["p/f", "p/g"] },
}));
process.env.PI_CODING_AGENT_DIR = agentDir;

async function loadJiti() {
  try {
    return await import("jiti");
  } catch {
    const piDir = dirname(dirname(fileURLToPath(await import.meta.resolve("@earendil-works/pi-coding-agent"))));
    return import(pathToFileURL(join(piDir, "node_modules/jiti/lib/jiti.mjs")).href);
  }
}
const { createJiti } = await loadJiti();
const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const jiti = createJiti(join(projectDir, "tests/"));
const bifrost = (await jiti.import(join(projectDir, "index.ts"))).default;

function harness() {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const deliveries = [];
  const notices = [];
  const models = ["c", "f", "g"].map((id) => ({
    provider: "p",
    id,
    name: id,
    api: "openai-completions",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }));
  let ctx;
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, cmd) => commands.set(name, cmd),
    sendUserMessage: (text, options) => {
      sent.push(text);
      deliveries.push({ text, options });
    },
    setModel: async (model) => {
      ctx.model = model;
      return true;
    },
    getThinkingLevel: () => "medium",
  };
  bifrost(new Proxy(pi, { get: (t, k) => t[k] ?? (() => {}) }));
  ctx = {
    model: models[0],
    thinkingLevel: "medium",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: new Proxy({ notify: (m) => notices.push(m), theme: { fg: (_c, s) => s } }, { get: (t, k) => t[k] ?? (() => {}) }),
    session: { custom: {} },
    modelRegistry: {
      getAvailable: () => models,
      find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      refresh: async () => {},
    },
  };
  return { handlers, commands, sent, deliveries, notices, ctx };
}

describe("category slash commands", () => {
  it("registers one command per configured category", () => {
    const { commands } = harness();
    for (const tier of ["coding", "frontier"]) assert.ok(commands.has(tier), `/${tier} registered`);
  });

  it("forces the category and forwards only the prompt", async () => {
    const { handlers, commands, sent, notices, ctx } = harness();
    await commands.get("frontier").handler("  debug this  ", ctx);
    assert.deepEqual(sent, ["debug this"]);
    await handlers.get("input")({ text: "debug this", source: "extension" }, ctx);
    assert.ok(notices.some((n) => /classify: frontier \[!\]/.test(n)), notices.join("\n"));
  });

  it("ignores other extension messages and warns on an empty prompt", async () => {
    const { handlers, commands, sent, notices, ctx } = harness();
    await commands.get("coding").handler("   ", ctx);
    assert.equal(sent.length, 0);
    assert.ok(notices.some((n) => /Usage: \/coding <prompt>/.test(n)));
    const r = await handlers.get("input")({ text: "hello", source: "extension" }, ctx);
    assert.deepEqual(r, { action: "continue" });
    assert.ok(!notices.some((n) => /classify:/.test(n)));
  });

  it("queues a fallback replay after agent_settled", async () => {
    const { handlers, commands, deliveries, ctx } = harness();
    await commands.get("frontier").handler("retry me", ctx);
    await handlers.get("input")({ text: "retry me", source: "extension" }, ctx);
    await handlers.get("agent_end")({
      messages: [{
        role: "assistant",
        provider: "p",
        model: "f",
        content: [],
        stopReason: "error",
        errorMessage: "429: temporarily rate-limited upstream",
      }],
    }, ctx);
    await handlers.get("agent_settled")({}, ctx);

    assert.equal(ctx.model.id, "g");
    assert.deepEqual(deliveries.at(-1), {
      text: "retry me",
      options: { deliverAs: "followUp" },
    });
  });
});
