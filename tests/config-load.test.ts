import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES, loadConfig, loadRules } from "../config.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("config load", () => {
  it("uses in-code defaults when config files missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.default, "general");
      assert.equal(config.silent, false);
      assert.deepEqual(config.categoryStrategies, {
        quick: "first",
        general: "first",
        writing: "first",
        coding: "first",
        frontier: "first",
      });
      assert.deepEqual(config.models, {});
      assert.equal(config.rules, DEFAULT_RULES);
      assert.deepEqual(loadRules(cwd, config), DEFAULT_RULES);
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("merges extension and global configs, global wins", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(extensionDir, "bifrost.json"), {
        enabled: false,
        silent: true,
        default: "quick",
        strategy: "cheapest",
        categoryStrategies: { quick: "cheapest" },
        models: {
          quick: ["ext-quick"],
          general: ["ext-general"],
        },
      });

      writeJson(join(getAgentDir(), "bifrost.json"), {
        enabled: true,
        silent: false,
        default: "frontier",
        strategy: "random",
        categoryStrategies: { general: "cheapest" },
        models: { general: ["global-general"], quick: ["global-quick"] },
      });

      // Per-project configs must NOT influence routing.
      writeJson(join(cwd, "bifrost.json"), {
        default: "quick",
        models: { frontier: ["cwd-frontier"] },
      });
      writeJson(join(cwd, ".pi", "bifrost.json"), {
        models: { quick: ["project-quick"] },
      });

      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.enabled, true);
      assert.equal(config.silent, false);
      assert.equal(config.default, "frontier");
      assert.equal(config.strategy, "random");
      assert.deepEqual(config.categoryStrategies, {
        quick: "cheapest",
        general: "cheapest",
        writing: "first",
        coding: "first",
        frontier: "first",
      });
      assert.deepEqual(config.models, {
        quick: ["global-quick"],
        general: ["global-general"],
      });
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores corrupt config layers and keeps later valid layers", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeFileSync(join(extensionDir, "bifrost.json"), "{not json", "utf8");
      writeJson(join(getAgentDir(), "bifrost.json"), {
        default: "quick",
        models: { quick: ["agent-quick"] },
      });

      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.default, "quick");
      assert.deepEqual(config.models, { quick: ["agent-quick"] });
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
