import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

describe("startup registry refresh", () => {
  it("awaits registry refresh before validating candidate models on session_start", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "bifrost-startup-"));
    const agentDir = join(tempHome, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "bifrost.json"),
      JSON.stringify({
        enabled: true,
        models: {
          general: ["antigravity/claude-sonnet-5-5"],
        },
      }),
    );

    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const jiti = jitiFactory(process.cwd());
      const bifrost = (await jiti.import("./index.ts")).default;
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
      bifrost(new Proxy(pi, { get: (t, k) => t[k] ?? (() => {}) }));

      let refreshCalled = false;
      let refreshFinished = false;
      let findCalledBeforeRefreshEnd = false;

      const dynamicModel = {
        provider: "antigravity",
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
      };

      const ctx = {
        model: { provider: "p", id: "a" },
        thinkingLevel: "medium",
        mode: "tui",
        hasUI: true,
        ui: new Proxy(
          {
            notify: (m) => notices.push(m),
            setStatus: () => {},
            theme: { fg: (_c, s) => s },
          },
          { get: (t, k) => t[k] ?? (() => {}) },
        ),
        session: { custom: {} },
        modelRegistry: {
          getAvailable: () => (refreshFinished ? [dynamicModel] : []),
          find: (provider, id) => {
            if (!refreshFinished) findCalledBeforeRefreshEnd = true;
            return refreshFinished && provider === "antigravity" && id === "claude-sonnet-5-5"
              ? dynamicModel
              : undefined;
          },
          refresh: async () => {
            refreshCalled = true;
            await new Promise((r) => setTimeout(r, 20));
            refreshFinished = true;
          },
        },
      };

      await handlers.get("session_start")({}, ctx);

      assert.equal(refreshCalled, true, "modelRegistry.refresh must be called on session_start");
      assert.equal(refreshFinished, true, "modelRegistry.refresh must be awaited before session_start continues");
      assert.equal(findCalledBeforeRefreshEnd, false, "candidate lookup must not happen before refresh finishes");
      assert.deepEqual(notices, [], "no unresolvable pattern warnings when model is available after refresh");
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
