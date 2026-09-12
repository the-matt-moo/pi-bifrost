import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoPinSource, createPipeline, type PipelineDeps } from "../classification-pipeline.ts";
import type { SessionRoutingContext } from "../session-context.ts";
import { makeClassifierModel } from "./helpers.ts";

/** A session-momentum stub that always suggests `tier`, independent of
 *  SessionRoutingContext's fuzzy topic-change heuristics (covered by
 *  session-context.test.ts). Keeps conflict-resolution tests deterministic. */
function fakeSessionContext(tier: string | undefined): SessionRoutingContext {
  return { suggest: () => tier } as unknown as SessionRoutingContext;
}

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    cacheLookup: () => undefined,
    classifierModels: [],
    classifyWithLLM: async () => undefined,
    regexRules: [],
    defaultTier: undefined,
    tiers: ["frontier", "economical"],
    ...overrides,
  };
}

describe("classification-pipeline", () => {
  describe("autoPinSource", () => {
    it("pins automatic classifications and fallback, but not inline overrides", () => {
      assert.equal(autoPinSource({ kind: "classified", tier: "frontier", source: "regex" }), "regex");
      assert.equal(autoPinSource({ kind: "fallback", tier: "general" }), "fallback");
      assert.equal(autoPinSource({ kind: "classified", tier: "frontier", source: "inline" }), undefined);
      assert.equal(autoPinSource({ kind: "unclassified" }), undefined);
    });
  });

  describe("unclassified", () => {
    it("returns unclassified when no tiers configured", async () => {
      const p = createPipeline(deps({ tiers: [] }));
      const r = await p.classify("hello");
      assert.equal(r.kind, "unclassified");
    });

    it("returns unclassified when nothing matches and no default", async () => {
      const p = createPipeline(deps({ defaultTier: undefined }));
      const r = await p.classify("hello");
      assert.equal(r.kind, "unclassified");
    });
  });

  describe("cache", () => {
    it("returns classified from cache hit", async () => {
      const p = createPipeline(
        deps({ cacheLookup: () => "economical" }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "economical");
        assert.equal(r.source, "cache");
      }
    });

    it("skips cache when result is not a known tier", async () => {
      const p = createPipeline(
        deps({ cacheLookup: () => "unknown" }),
      );
      const r = await p.classify("hello");
      // Falls through to default
      assert.notEqual(r.kind, "classified");
    });
  });

  describe("classifier", () => {
    it("uses first successful classifier model", async () => {
      let calls = 0;
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")],
          classifyWithLLM: async (model) => {
            calls++;
            if (model.kind === "registry" && model.model.id === "m1") return "frontier";
            return undefined;
          },
        }),
      );
      const r = await p.classify("debug this");
      assert.equal(calls, 1); // second model never tried
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "frontier");
        assert.equal(r.source, "classifier");
      }
    });

    it("tries second model when first fails", async () => {
      let calls: string[] = [];
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")],
          classifyWithLLM: async (model) => {
            calls.push(model.kind === "registry" ? model.model.id : model.id);
            if (model.kind === "registry" && model.model.id === "m2") return "economical";
            return undefined;
          },
        }),
      );
      const r = await p.classify("hello");
      assert.deepEqual(calls, ["m1", "m2"]);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "classifier");
      }
    });

    it("does not retry another classifier after a valid rejection", async () => {
      let calls = 0;
      const p = createPipeline(deps({
        classifierModels: [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")],
        classifyWithLLM: async () => {
          calls++;
          return { status: "rejected" };
        },
        defaultTier: "economical",
      }));
      const result = await p.classify("ambiguous request");
      assert.equal(calls, 1);
      assert.equal(result.kind, "fallback");
    });

    it("validates classifier result against known tiers", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => "unknown",
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello");
      // Unknown tier → falls through to default
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });

    it("skips classifier when classifierModels is empty", async () => {
      let called = false;
      const p = createPipeline(
        deps({
          classifierModels: [],
          classifyWithLLM: async () => { called = true; return "frontier"; },
          regexRules: [{ pattern: "hello", model: "frontier" }],
        }),
      );
      await p.classify("hello");
      assert.equal(called, false);
    });

    it("caps classifier model attempts", async () => {
      let calls = 0;
      const p = createPipeline(deps({
        classifierModels: [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")],
        classifierMaxAttempts: 1,
        classifyWithLLM: async () => { calls++; return undefined; },
        defaultTier: "economical",
      }));
      const result = await p.classify("ambiguous request");
      assert.equal(calls, 1);
      assert.equal(result.kind, "fallback");
    });

    it("shares classifier cooldowns across pipeline rebuilds", async () => {
      const cooldowns = new Map<string, number>();
      let now = 1_000;
      const models = [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")];
      const first = createPipeline(deps({
        classifierModels: models,
        classifierMaxAttempts: 1,
        classifierCooldowns: cooldowns,
        classifierCooldownMs: 100,
        now: () => now,
        classifyWithLLM: async () => undefined,
      }));
      await first.classify("ambiguous request");
      assert.equal(cooldowns.get("a/m1"), 1_100);

      const calls: string[] = [];
      const rebuilt = createPipeline(deps({
        classifierModels: models,
        classifierMaxAttempts: 1,
        classifierCooldowns: cooldowns,
        now: () => now,
        classifyWithLLM: async (model) => {
          calls.push(model.kind === "registry" ? model.model.id : model.id);
          return "frontier";
        },
      }));
      const result = await rebuilt.classify("another ambiguous request");
      assert.deepEqual(calls, ["m2"]);
      assert.equal(result.kind, "classified");

      now = 1_101;
      assert.ok(now > (cooldowns.get("a/m1") ?? 0));
    });

    it("aborts classification after the total timeout", async () => {
      let aborted = false;
      const p = createPipeline(deps({
        classifierModels: [makeClassifierModel("a", "m1")],
        classifierTimeoutMs: 5,
        defaultTier: "economical",
        classifyWithLLM: async (_model, _text, _tiers, signal) => new Promise((resolve) => {
          signal?.addEventListener("abort", () => { aborted = true; resolve(undefined); }, { once: true });
        }),
      }));
      const result = await p.classify("ambiguous request");
      assert.equal(aborted, true);
      assert.equal(result.kind, "fallback");
    });
  });

  describe("regex", () => {
    it("matches regex rule", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bdebug\\b", model: "frontier" }],
        }),
      );
      const r = await p.classify("debug the thing");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "frontier");
        assert.equal(r.source, "regex");
      }
    });

    it("matches regex rule with direct model reference", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bcommit\\b", model: "opencode-go/glm-5.1" }],
        }),
      );
      const r = await p.classify("commit the changes");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "opencode-go/glm-5.1");
        assert.equal(r.source, "regex");
      }
    });

    it("direct model reference bypasses tier lookup", async () => {
      // Model reference "unknown/model" is not in tiers, should still match.
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: ".*", model: "custom/model" }],
          tiers: ["frontier"],
        }),
      );
      const r = await p.classify("anything");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "custom/model");
      }
    });

    it("can disable regex fallback after classifier failure", async () => {
      const p = createPipeline(deps({
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => ({ status: "failed" }),
        regexRules: [{ pattern: "hello", model: "frontier" }],
        fallbackToRegex: false,
        defaultTier: "economical",
      }));
      const result = await p.classify("hello");
      assert.equal(result.kind, "fallback");
      if (result.kind === "fallback") assert.equal(result.tier, "economical");
    });

    it("falls through to default when no rule matches", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bdebug\\b", model: "frontier" }],
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello world");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });

  describe("priority order", () => {
    it("cache beats classifier", async () => {
      let classifierCalled = false;
      const p = createPipeline(
        deps({
          cacheLookup: () => "frontier",
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { classifierCalled = true; return "economical"; },
        }),
      );
      const r = await p.classify("test");
      assert.equal(classifierCalled, false);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "cache");
      }
    });

    it("classifier beats regex", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => "economical",
          regexRules: [{ pattern: ".*", model: "frontier" }],
        }),
      );
      const r = await p.classify("test");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "classifier");
        assert.equal(r.tier, "economical");
      }
    });

    it("regex beats default", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: ".*", model: "frontier" }],
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("test");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "regex");
      }
    });
  });

  describe("fallback", () => {
    it("returns fallback when only default matches", async () => {
      const p = createPipeline(
        deps({ defaultTier: "economical" }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });

  describe("configured regex intent vs stale cache/session/complexity", () => {
    it("a same-turn coding regex match beats a stale cached general tier", async () => {
      const p = createPipeline(deps({
        cacheLookup: () => "general",
        regexRules: [{ pattern: "\\bimplement\\b", model: "coding" }],
        tiers: ["general", "coding"],
      }));
      const r = await p.classify("implement the login endpoint");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "coding");
        assert.equal(r.source, "regex");
      }
    });

    it("returns from cache when the cached tier already matches the regex intent", async () => {
      const p = createPipeline(deps({
        cacheLookup: () => "coding",
        regexRules: [{ pattern: "\\bimplement\\b", model: "coding" }],
        tiers: ["coding", "frontier"],
      }));
      const r = await p.classify("implement this");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "coding");
        assert.equal(r.source, "cache");
      }
    });

    it("a same-turn coding regex match beats stale session momentum from a planning turn", async () => {
      const p = createPipeline(deps({
        regexRules: [{ pattern: "\\bimplement\\b", model: "coding" }],
        tiers: ["coding", "frontier"],
        sessionContext: fakeSessionContext("frontier"),
      }));
      const r = await p.classify("implement the first task from the plan");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "coding");
        assert.equal(r.source, "regex");
      }
    });

    it("session momentum still applies when it agrees with the regex intent", async () => {
      const p = createPipeline(deps({
        regexRules: [{ pattern: "\\bimplement\\b", model: "coding" }],
        tiers: ["coding", "frontier"],
        sessionContext: fakeSessionContext("coding"),
      }));
      const r = await p.classify("implement this");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "coding");
        assert.equal(r.source, "cache");
      }
    });

    it("a matched coding rule keeps a short prompt off the quick complexity shortcut", async () => {
      const p = createPipeline(deps({
        regexRules: [{ pattern: "\\bfix bug\\b", model: "coding" }],
        tiers: ["quick", "coding", "frontier"],
      }));
      const r = await p.classify("fix bug");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "coding");
        assert.equal(r.source, "regex");
      }
    });

    it("a matched coding rule keeps a multi-file prompt off the frontier complexity escalation", async () => {
      const p = createPipeline(deps({
        regexRules: [{ pattern: "\\bimplement\\b", model: "coding" }],
        tiers: ["coding", "frontier"],
      }));
      const r = await p.classify("implement the fix across a.ts, b.ts, and c.ts");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "coding");
        assert.equal(r.source, "regex");
      }
    });
  });

  describe("classifier error resilience", () => {
    it("catches classifier throw and falls through to regex", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { throw new Error("boom"); },
          regexRules: [{ pattern: ".*", model: "frontier" }],
        }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "regex");
      }
    });

    it("catches classifier throw and falls through to default", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { throw new Error("boom"); },
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });
});
