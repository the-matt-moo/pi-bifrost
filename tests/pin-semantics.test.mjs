// Pin semantics: model switching must NOT pin thinking, regardless of whether Pi's
// concurrent thinking_level_select handler reaches Bifrost before or after model_select.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// index.ts uses ".js" specifiers for ".ts" files — load it the way Pi does (jiti).
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
  const notices = [];
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: () => {},
    registerShortcut: () => {},
    registerStatus: () => {},
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
  };
  const proxy = new Proxy(pi, { get: (t, k) => t[k] ?? (() => {}) });
  bifrost(proxy);
  const status = new Map();
  const ctx = (id) => ({
    // no cwd: keeps setBifrostModeStatus from writing the real statusline.json
    model: { provider: "p", id },
    thinkingLevel: "medium",
    mode: "tui",
    hasUI: true,
    ui: new Proxy(
      {
        notify: (m) => notices.push(m),
        setStatus: (k, v) => status.set(k, v),
        theme: { fg: (_c, s) => s },
      },
      { get: (t, k) => t[k] ?? (() => {}) },
    ),
    session: { custom: {} },
    modelRegistry: {
      getAvailable: () => [{ provider: "p", id }],
      find: () => undefined,
      refresh: async () => {},
    },
  });
  const thinkingPinned = () => /think:pinned/.test(status.get("bifrost-state") ?? "");
  return { handlers, notices, ctx, thinkingPinned };
}

describe("pin semantics", () => {
  it("a same-model change pins thinking; a model switch does not", async () => {
    const { handlers, ctx, thinkingPinned } = harness();
    await handlers.get("session_start")({}, ctx("a"));

    // A manual thinking change under the same model → pinned.
    await handlers.get("thinking_level_select")({ level: "high" }, ctx("a"));
    assert.ok(thinkingPinned(), "manual thinking cycle should pin thinking");

    // Model already switched, thinking re-clamped → must NOT pin thinking.
    const fresh = harness();
    await fresh.handlers.get("session_start")({}, fresh.ctx("a"));
    await fresh.handlers.get("thinking_level_select")({ level: "low" }, fresh.ctx("b"));
    await fresh.handlers.get("model_select")({}, fresh.ctx("b"));
    // Concurrent delivery can arrive late, after model_select.
    await fresh.handlers.get("thinking_level_select")({ level: "medium" }, fresh.ctx("b"));
    assert.equal(fresh.thinkingPinned(), false, "model switch must not pin thinking");

    // ...and thinking is still pinnable after the switch event batch settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fresh.handlers.get("thinking_level_select")({ level: "high" }, fresh.ctx("b"));
    assert.ok(fresh.thinkingPinned(), "thinking pin still works after a model switch");
  });
});
