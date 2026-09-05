import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSessionState } from "../session-cleanup.ts";

function withTempAgentDir(fn: (agentDir: string) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), "bifrost-agent-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    fn(agentDir);
  } finally {
    process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

describe("session cleanup", () => {
  it("removes stale session state directories and keeps recent ones", () => {
    withTempAgentDir((agentDir) => {
      const root = join(agentDir, "bifrost-sessions");
      const staleDir = join(root, "old-session");
      const freshDir = join(root, "fresh-session");
      mkdirSync(staleDir, { recursive: true });
      mkdirSync(freshDir, { recursive: true });
      const staleFile = join(staleDir, "bifrost-state.json");
      const freshFile = join(freshDir, "bifrost-state.json");
      writeFileSync(staleFile, "{}", "utf8");
      writeFileSync(freshFile, "{}", "utf8");
      const now = Date.now();
      utimesSync(staleFile, new Date(now - 10 * 24 * 60 * 60_000), new Date(now - 10 * 24 * 60 * 60_000));
      utimesSync(freshFile, new Date(now), new Date(now));

      const result = cleanupSessionState({ rootDir: root, maxAgeMs: 7 * 24 * 60 * 60_000, now });
      assert.equal(result.removed, 1);
      assert.equal(result.scanned, 2);
      assert.equal(result.errors.length, 0);
      assert.equal(existsSync(staleDir), false);
      assert.equal(existsSync(freshDir), true);
    });
  });
});
