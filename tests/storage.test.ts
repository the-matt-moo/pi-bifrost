import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, resolveStoragePath, writeJsonFile, writeJsonFileAtomic } from "../storage.ts";

describe("storage", () => {
  it("resolves absolute, tilde, and agent-dir-relative paths", () => {
    const cwd = "/project";
    const home = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = "/home/user";
    process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/agent";
    try {
      assert.equal(
        resolveStoragePath(cwd, undefined, ".pi/state.json"),
        join("/home/user/.pi/agent", ".pi/state.json"),
      );
      assert.equal(resolveStoragePath(cwd, "/var/lib/state.json", ".pi/state.json"), "/var/lib/state.json");
      assert.equal(resolveStoragePath(cwd, "~/state.json", ".pi/state.json"), "/home/user/state.json");
      assert.equal(
        resolveStoragePath(cwd, "state.json", ".pi/state.json"),
        join("/home/user/.pi/agent", "state.json"),
      );
    } finally {
      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }
  });

  it("writes and reads json files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "nested", "state.json");
      writeJsonFile(path, { ok: true, count: 2 });
      assert.deepEqual(readJsonFile<{ ok: boolean; count: number }>(path), { ok: true, count: 2 });
      assert.equal(readJsonFile(join(cwd, "missing.json")), undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes atomically to json files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "nested", "atomic.json");
      writeJsonFileAtomic(path, { ok: true });
      assert.deepEqual(readJsonFile(path), { ok: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});