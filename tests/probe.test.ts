import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe } from "../probe.ts";

// Probe results persist to the agent dir (~/.pi/agent/bifrost-probe.json), so
// tests must redirect PI_CODING_AGENT_DIR to a temp dir for isolation.
async function withTempAgentDir(fn: (cwd: string) => Promise<void> | void): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  try {
    await fn(cwd);
  } finally {
    process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("probe transport", () => {
  it("uses provider.streamSimple", async () => {
    await withTempAgentDir(async () => {
      const model = {
        provider: "openai-codex",
        id: "gpt-5.4-mini",
        api: "openai-codex-responses",
        cost: { input: 0.75, output: 4.5 },
        baseUrl: "https://example.invalid/v1",
      };
      const ctx = {
        modelRegistry: {
          getAvailable: () => [model],
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                role: "assistant",
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-5.4-mini",
                content: [{ type: "text", text: "2" }],
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              }),
            }),
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      const result = await runProbe(ctx);
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
    });
  });

  it("treats thinking-only stream response as ok", async () => {
    await withTempAgentDir(async () => {
      const model = {
        provider: "openai-codex",
        id: "gpt-5.4-mini",
        api: "openai-codex-responses",
        cost: { input: 0.75, output: 4.5 },
        baseUrl: "https://example.invalid/v1",
      };
      const ctx = {
        modelRegistry: {
          getAvailable: () => [model],
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                role: "assistant",
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-5.4-mini",
                content: [],
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              }),
            }),
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      const result = await runProbe(ctx);
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
    });
  });

  it("returns error when stream stopReason is error", async () => {
    await withTempAgentDir(async () => {
      const model = {
        provider: "openai-codex",
        id: "gpt-5.4-mini",
        api: "openai-codex-responses",
        cost: { input: 0.75, output: 4.5 },
        baseUrl: "https://example.invalid/v1",
      };
      const ctx = {
        modelRegistry: {
          getAvailable: () => [model],
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                role: "assistant",
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-5.4-mini",
                content: [],
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "error",
                errorMessage: "empty response",
                timestamp: Date.now(),
              }),
            }),
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      const result = await runProbe(ctx);
      assert.equal(result.results[0]?.status, "error");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
    });
  });

  it("reuses fresh successful probes and honors force", async () => {
    await withTempAgentDir(async () => {
      const model = {
        provider: "test",
        id: "fast",
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        cost: { input: 0, output: 0 },
      };
      const otherModel = { ...model, id: "other" };
      let available = [model, otherModel];
      let calls = 0;
      const ctx = {
        modelRegistry: {
          getAvailable: () => available,
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => {
                calls++;
                return {
                  content: [{ type: "text", text: "2" }],
                  usage: { totalTokens: 2 },
                  stopReason: "stop",
                };
              },
            }),
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      const first = await runProbe(ctx);
      assert.equal(first.cached, 0);
      assert.equal(calls, 2);
      available = [model];
      const second = await runProbe(ctx);
      assert.equal(second.cached, 1);
      assert.equal(second.freshResults.length, 0);
      assert.equal(calls, 2);
      const forced = await runProbe(ctx, undefined, undefined, { force: true });
      assert.equal(forced.cached, 0);
      assert.equal(calls, 3);
      available = [otherModel];
      const preserved = await runProbe(ctx);
      assert.equal(preserved.cached, 1);
      assert.equal(calls, 3);
    });
  });
});