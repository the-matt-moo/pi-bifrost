import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRuntimeState,
  runtimeStatePath,
  saveRuntimeState,
  type PersistedModeState,
  type RuntimeModeState,
} from "../runtime-state.ts";

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

describe("runtime state", () => {
  it("saves and loads persisted mode", () => {
    withTempAgentDir(() => {
      const path = runtimeStatePath("/project");
      const state: PersistedModeState = { enabled: false, classifierEnabled: false, silent: true };
      saveRuntimeState(path, state);
      // pinned is ephemeral — always false on load regardless of file
      const loaded = loadRuntimeState(path);
      assert.deepEqual(loaded, { ...state, pinned: false });
    });
  });

  it("uses fallback when file missing", () => {
    withTempAgentDir(() => {
      const path = runtimeStatePath("/project");
      const fallback: RuntimeModeState = { enabled: false, pinned: true, classifierEnabled: false, silent: true };
      assert.deepEqual(loadRuntimeState(path, fallback), fallback);
    });
  });

  it("falls back on corrupt file", () => {
    withTempAgentDir((agentDir) => {
      const path = runtimeStatePath("/project");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path, "{not json", "utf8");
      const fallback: RuntimeModeState = { enabled: true, pinned: true, classifierEnabled: false, silent: true };
      assert.deepEqual(loadRuntimeState(path, fallback), fallback);
    });
  });
});