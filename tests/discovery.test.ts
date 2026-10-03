import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BifrostConfig } from "../config.ts";
import {
  discoverModels,
  reconcileDiscoveredModels,
  type DiscoveryOptions,
} from "../discovery.ts";

function model(provider: string, id: string, cost = 0, baseUrl = "https://example.test/v1"): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: cost, output: cost, cacheRead: cost, cacheWrite: cost },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function context(
  all: Model<Api>[],
  available = all,
  scoped: Model<Api>[] = [],
  names: Record<string, string> = {},
): ExtensionContext {
  return {
    scopedModels: scoped.map((entry) => ({ model: entry })),
    modelRegistry: {
      getAll: () => all,
      getAvailable: () => available,
      getProviderDisplayName: (provider: string) => names[provider] ?? provider,
    },
  } as unknown as ExtensionContext;
}

const scopedOnly: DiscoveryOptions = { scoped: true, free: false };
const freeOnly: DiscoveryOptions = { scoped: false, free: true };
const both: DiscoveryOptions = { scoped: true, free: true };

describe("discovery sources", () => {
  it("keeps --scoped independent from OpenRouter free models", () => {
    const scoped = model("vendor", "selected", 1);
    const free = model("dynamic-or", "free", 0, "https://openrouter.ai/api/v1");
    const result = discoverModels(context([free, scoped], [free, scoped], [scoped]), scopedOnly);
    assert.deepEqual(result.candidates.map((entry) => entry.id), ["selected"]);
    assert.equal(result.sourceModels.free, undefined);
  });

  it("excludes a model removed from the current session's scoped selection", () => {
    const removed = model("vendor", "removed", 1);
    const kept = model("vendor", "kept", 1);
    const result = discoverModels(
      context([removed, kept], [removed, kept], [removed, kept]),
      scopedOnly,
      new Set(["vendor/removed"]),
    );
    assert.deepEqual(result.candidates.map((entry) => `${entry.provider}/${entry.id}`), ["vendor/kept"]);
    assert.deepEqual(result.sourceModels.scoped?.map((entry) => `${entry.provider}/${entry.id}`), ["vendor/kept"]);
  });

  it("finds --free from provider and cost metadata without a fixed provider id", () => {
    const free = model("dynamic-provider", "current-free", 0);
    const paid = model("dynamic-provider", "paid", 1);
    const result = discoverModels(
      context([paid, free], [paid, free], [], { "dynamic-provider": "OpenRouter" }),
      freeOnly,
    );
    assert.deepEqual(result.candidates.map((entry) => entry.id), ["current-free"]);
  });

  it("returns a deterministic deduplicated union", () => {
    const duplicate = model("dynamic-provider", "same", 0);
    const scoped = model("vendor", "selected", 1);
    const result = discoverModels(
      context([scoped, duplicate], [scoped, duplicate], [duplicate, scoped], { "dynamic-provider": "OpenRouter" }),
      both,
    );
    assert.deepEqual(result.candidates.map((entry) => `${entry.provider}/${entry.id}`), [
      "dynamic-provider/same",
      "vendor/selected",
    ]);
    assert.equal(result.duplicateCount, 1);
  });

  it("reports unavailable requested sources", () => {
    const result = discoverModels(context([]), both);
    assert.deepEqual(result.unavailableSources.sort(), ["free", "scoped"]);
    assert.equal(result.candidates.length, 0);
  });
});

describe("discovery reconciliation", () => {
  it("adds new verified models, removes stale managed models, and preserves manual config", () => {
    const added = model("vendor", "new", 0.4);
    const discovery = {
      candidates: [added],
      sourceModels: { scoped: [added] },
      skipped: [],
      messages: [],
      unavailableSources: [],
      duplicateCount: 0,
    };
    const config: BifrostConfig = {
      enabled: false,
      default: "general",
      strategy: "largest_context",
      categoryStrategies: { general: "first" },
      models: { general: ["manual/keep", "vendor/old"] },
      rules: [{ pattern: "manual", model: "general" }],
      discovery: { managed: { "vendor/old": ["scoped"] } },
    };

    const result = reconcileDiscoveredModels(config, discovery, scopedOnly, new Set(["vendor/new"]));
    assert.deepEqual(result.added, [{ model: "vendor/new", tier: "quick" }]);
    assert.deepEqual(result.removed, [{ model: "vendor/old", tier: "general" }]);
    assert.deepEqual(result.config.models, { general: ["manual/keep"], quick: ["vendor/new"] });
    assert.equal(result.config.enabled, false);
    assert.equal(result.config.strategy, "largest_context");
    assert.deepEqual(result.config.rules, config.rules);
  });

  it("does not remove ownership from an unselected source", () => {
    const config: BifrostConfig = {
      models: { quick: ["vendor/shared"] },
      discovery: { managed: { "vendor/shared": ["scoped", "free"] } },
    };
    const discovery = {
      candidates: [],
      sourceModels: { scoped: [] },
      skipped: [],
      messages: [],
      unavailableSources: [],
      duplicateCount: 0,
    };

    const result = reconcileDiscoveredModels(config, discovery, scopedOnly, new Set());
    assert.deepEqual(result.config.models, { quick: ["vendor/shared"] });
    assert.deepEqual(result.config.discovery?.managed, { "vendor/shared": ["free"] });
    assert.deepEqual(result.removed, []);
  });

  it("keeps a managed model when ownership moves between selected sources", () => {
    const shared = model("dynamic-provider", "shared", 0);
    const discovery = {
      candidates: [shared],
      sourceModels: { scoped: [], free: [shared] },
      skipped: [],
      messages: [],
      unavailableSources: [],
      duplicateCount: 0,
    };
    const config: BifrostConfig = {
      models: { quick: ["dynamic-provider/shared"] },
      discovery: { managed: { "dynamic-provider/shared": ["scoped"] } },
    };

    const result = reconcileDiscoveredModels(config, discovery, both, new Set(["dynamic-provider/shared"]));
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.config.discovery?.managed, { "dynamic-provider/shared": ["free"] });
  });

  it("never adopts a pre-existing manual entry as discovery-managed", () => {
    const existing = model("vendor", "manual", 0);
    const discovery = {
      candidates: [existing],
      sourceModels: { free: [existing] },
      skipped: [],
      messages: [],
      unavailableSources: [],
      duplicateCount: 0,
    };
    const config: BifrostConfig = { models: { quick: ["vendor/manual"] } };

    const result = reconcileDiscoveredModels(config, discovery, freeOnly, new Set(["vendor/manual"]));
    assert.deepEqual(result.config.models, config.models);
    assert.deepEqual(result.config.discovery?.managed, {});
  });
});
