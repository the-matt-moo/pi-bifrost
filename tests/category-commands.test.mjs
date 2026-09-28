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
  models: { coding: ["p/c"], frontier: ["p/f"] },
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
  const notices = [];
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, cmd) => commands.set(name, cmd),
    sendUserMessage: (text) => sent.push(text),
    getThinkingLevel: () => "medium",
  };
  bifrost(new Proxy(pi, { get: (t, k) => t[k] ?? (() => {}) }));
  const ctx = {
    model: { provider: "p", id: "c" },
    thinkingLevel: "medium",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: new Proxy({ notify: (m) => notices.push(m), theme: { fg: (_c, s) => s } }, { get: (t, k) => t[k] ?? (() => {}) }),
    session: { custom: {} },
    modelRegistry: { getAvailable: () => [], find: () => undefined, refresh: async () => {} },
  };
  return { handlers, commands, sent, notices, ctx };
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
});
