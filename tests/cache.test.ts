import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalize,
  lookupCache,
  touchCacheEntry,
  updateCache,
  cachePath,
  loadCache,
  createDeferredCacheWriter,
} from "../cache.ts";

describe("cache", () => {
  describe("normalize", () => {
    it("lowercases, strips punctuation, sorts tokens", () => {
      assert.equal(normalize("Hello, World!"), "hello world");
      assert.equal(normalize("  Plan   the architecture? "), "architecture plan the");
    });

    it("returns empty string for empty input", () => {
      assert.equal(normalize(""), "");
    });

    it("preserves non-Latin characters", () => {
      const result = normalize("调试 内存泄漏");
      assert.ok(result.includes("调试"));
      assert.ok(result.includes("内存泄漏"));
    });

    it("normalizes empty string for Jaccard edge case", () => {
      // Empty-vs-empty should still produce cache-viable normalized form
      assert.equal(normalize("!@#$%"), "");
    });
  });

  describe("lookupCache", () => {
    it("returns entry for exact match (no mutation)", () => {
      const entries = [
        { normalized: "hello world", category: "economical", lastUsed: 1, hits: 5 },
      ];
      const result = lookupCache(entries, "Hello World!", 0.85);
      assert.ok(result);
      assert.equal(result!.category, "economical");
      assert.equal(entries[0].hits, 5);
      assert.equal(entries[0].lastUsed, 1);
    });

    it("returns entry for fuzzy match above threshold", () => {
      const entries = [
        { normalized: "hello world today is nice", category: "economical", lastUsed: 1, hits: 0 },
      ];
      const result = lookupCache(entries, "hello world today is good", 0.5);
      assert.ok(result);
      assert.equal(result!.category, "economical");
      assert.equal(entries[0].lastUsed, 1);
    });

    it("returns undefined when nothing matches", () => {
      const entries = [
        { normalized: "hello world", category: "economical", lastUsed: 1, hits: 0 },
      ];
      assert.equal(lookupCache(entries, "plan architecture", 0.85), undefined);
    });
  });

  describe("touchCacheEntry", () => {
    it("mutates lastUsed and hits", () => {
      const entry = { normalized: "hello", category: "economical", lastUsed: 100, hits: 3 };
      touchCacheEntry(entry);
      assert.ok(entry.lastUsed > 100);
      assert.equal(entry.hits, 4);
    });
  });

  describe("updateCache", () => {
    it("adds new entry", () => {
      const entries = updateCache([], "hello", "economical", 10);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].normalized, "hello");
      assert.equal(entries[0].category, "economical");
    });

    it("updates existing entry", () => {
      let entries = updateCache([], "hello", "economical", 10);
      entries = updateCache(entries, "hello", "frontier", 10);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].category, "frontier");
    });

    it("evicts oldest entries over cap", () => {
      let entries: ReturnType<typeof updateCache> = [];
      for (let i = 0; i < 5; i++) {
        entries = updateCache(entries, `token${i}`, "economical", 3);
      }
      assert.equal(entries.length, 3);
      assert.ok(!entries.some((e) => e.normalized === "token0"));
    });
  });

  describe("cachePath", () => {
    it("defaults to bifrost-cache.jsonl under the agent dir", () => {
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/agent";
      try {
        assert.equal(cachePath("/project"), join("/home/user/.pi/agent", "bifrost-cache.jsonl"));
      } finally {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    });

    it("expands leading tilde", () => {
      const home = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        assert.equal(cachePath("/project", "~/cache.jsonl"), "/home/user/cache.jsonl");
      } finally {
        process.env.HOME = home;
      }
    });

    it("joins relative path to the agent dir", () => {
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/agent";
      try {
        assert.equal(cachePath("/project", "cache.jsonl"), join("/home/user/.pi/agent", "cache.jsonl"));
      } finally {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    });
  });

  describe("deferred writer", () => {
    it("coalesces schedules and flushes the latest cache state", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "bifrost-cache-writer-"));
      const path = join(cwd, ".pi", "cache.jsonl");
      let entries = updateCache([], "first", "quick", 10);
      const writer = createDeferredCacheWriter(path, () => entries);
      try {
        writer.schedule();
        entries = updateCache(entries, "second", "frontier", 10);
        writer.schedule();
        await writer.flush();
        const saved = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(saved.length, 2);
        assert.equal(saved[1].normalized, "second");
        assert.equal("tokens" in saved[0], false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe("loadCache", () => {
    it("returns empty array for missing file", () => {
      const cwd = mkdtempSync(join(tmpdir(), "bifrost-cache-"));
      try {
        assert.deepEqual(loadCache(join(cwd, ".pi", "bifrost-cache.jsonl")), []);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("skips corrupt lines and keeps valid entries", () => {
      const cwd = mkdtempSync(join(tmpdir(), "bifrost-cache-"));
      try {
        const path = join(cwd, ".pi", "bifrost-cache.jsonl");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(path, "{not json\n{\"normalized\":\"hello\",\"category\":\"quick\",\"lastUsed\":1,\"hits\":2}\n", "utf8");
        const entries = loadCache(path);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].category, "quick");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
