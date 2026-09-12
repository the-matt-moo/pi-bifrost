import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateConfig,
  isStrictCategory,
  generateTierDescriptions,
  BUILTIN_CATEGORY_DESCRIPTIONS,
  type BifrostConfig,
} from "../config.ts";
import type { RoutingStrategy } from "../routing.ts";

const baseConfig: BifrostConfig = {
  enabled: true,
  default: "economical",
  strategy: "first",
  models: {
    frontier: ["model-a"],
    economical: ["model-b"],
  },
};

describe("validateConfig", () => {
  it("returns no issues for a valid config", () => {
    const issues = validateConfig(baseConfig);
    assert.equal(issues.length, 0);
  });

  it("errors when models is empty (two errors: no tiers + default missing)", () => {
    const issues = validateConfig({ ...baseConfig, models: {} });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 2);
    assert.ok(errors[0].message.includes('No tiers configured'));
    assert.ok(errors[1].message.includes('not found in models'));
  });

  it("errors when default tier is missing from models", () => {
    const issues = validateConfig({
      ...baseConfig,
      models: { frontier: ["model-a"] },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('not found in models'));
  });

  it("errors when category strategy references missing tier", () => {
    const issues = validateConfig({
      ...baseConfig,
      categoryStrategies: { nonexistent: "cheapest" },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('not found in models'));
  });

  it("warns on unknown strategy", () => {
    const issues = validateConfig({
      ...baseConfig,
      strategy: "unknown_strategy" as RoutingStrategy,
    });
    const warnings = issues.filter((i) => i.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('Unknown strategy'));
  });

  it("errors on invalid cache threshold", () => {
    const issues = validateConfig({
      ...baseConfig,
      cache: { threshold: 1.5 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('between 0 and 1'));
  });

  it("warns when cache maxEntries is 0", () => {
    const issues = validateConfig({
      ...baseConfig,
      cache: { maxEntries: 0 },
    });
    const warnings = issues.filter((i) => i.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('should be > 0'));
  });

  it("errors on invalid classifier performance limits", () => {
    const issues = validateConfig({
      ...baseConfig,
      classifier: { model: "test/model", timeoutMs: 0, maxAttempts: 0, cooldownSeconds: -1 },
    });
    const errors = issues.filter((issue) => issue.severity === "error");
    assert.equal(errors.length, 3);
  });

  it("errors on invalid regex in rules", () => {
    const issues = validateConfig({
      ...baseConfig,
      rules: [{ pattern: "[invalid", model: "frontier" }],
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('Invalid regex'));
  });

  it("errors on invalid reliability window", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { windowMinutes: 0 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("windowMinutes"));
  });

  it("errors on non-integer reliability window", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { windowMinutes: 1.5 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("integer"));
  });

  it("errors on non-integer reliability threshold", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { failureThreshold: NaN },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("integer"));
  });

  it("errors on non-integer reliability cooldown", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { cooldownMinutes: 1.5 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("integer"));
  });

  it("errors on invalid auto-retry limit", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { maxAutoRetries: 1.5 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("maxAutoRetries"));
  });

  it("allows multiple issues", () => {
    const issues = validateConfig({
      models: {},
      default: "frontier",
      rules: [{ pattern: "[invalid", model: "frontier" }],
    });
    assert.equal(issues.length, 3);
  });

  it("warns when strictCategories references a category not in models", () => {
    const issues = validateConfig({
      ...baseConfig,
      strictCategories: ["coding"],
    });
    const warnings = issues.filter((i) => i.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes("strictCategories"));
  });

  it("does not warn when strictCategories references a configured category", () => {
    const issues = validateConfig({
      ...baseConfig,
      strictCategories: ["frontier"],
    });
    assert.equal(issues.length, 0);
  });
});

describe("isStrictCategory", () => {
  it("defaults coding to strict only when coding is a configured category", () => {
    const withCoding: BifrostConfig = { models: { coding: ["model-a"] } };
    const withoutCoding: BifrostConfig = { models: { general: ["model-a"] } };
    assert.equal(isStrictCategory(withCoding, "coding"), true);
    assert.equal(isStrictCategory(withoutCoding, "coding"), false);
  });

  it("never treats an unconfigured category as strict, even if listed", () => {
    const config: BifrostConfig = { models: { general: ["model-a"] }, strictCategories: ["coding"] };
    assert.equal(isStrictCategory(config, "coding"), false);
  });

  it("honors an explicit strictCategories override, including opting coding out", () => {
    const config: BifrostConfig = { models: { coding: ["model-a"] }, strictCategories: [] };
    assert.equal(isStrictCategory(config, "coding"), false);
  });

  it("can mark a custom configured category as strict", () => {
    const config: BifrostConfig = { models: { premium: ["model-a"] }, strictCategories: ["premium"] };
    assert.equal(isStrictCategory(config, "premium"), true);
  });
});

describe("generateTierDescriptions", () => {
  it("uses built-in descriptions for known categories over generated keywords", () => {
    const descriptions = generateTierDescriptions(
      [{ pattern: "\\bdebug\\b", model: "coding" }],
      ["coding"],
    );
    assert.equal(descriptions.coding, BUILTIN_CATEGORY_DESCRIPTIONS.coding);
  });

  it("lets config overrides win over built-ins", () => {
    const descriptions = generateTierDescriptions(
      [{ pattern: "\\bdebug\\b", model: "coding" }],
      ["coding"],
      { coding: "custom coding description" },
    );
    assert.equal(descriptions.coding, "custom coding description");
  });

  it("still generates keyword descriptions for custom categories", () => {
    const descriptions = generateTierDescriptions(
      [{ pattern: "\\b(frontend|css|react)\\b", model: "frontend" }],
      ["frontend"],
    );
    assert.ok(descriptions.frontend?.includes("frontend"));
  });
});
