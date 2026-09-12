import { describe, it } from "node:test";
import assert from "node:assert/strict";

// resolveTierDisplay is not exported from commands.ts — it's internal.
// The handlers (handleInit, handleBenchmark, handlePreview) are also internal.
// These are tested via integration tests.
// This file verifies the routing helpers that commands.ts depends on.

import {
  getStrategy,
  selectModel,
  findCandidates,
  modelKey,
  guessTier,
} from "../routing.ts";
import { DEFAULT_RULES } from "../config.ts";
import { buildInitProposal } from "../commands.ts";
import { makeCtx, makeModel, withoutCost } from "./helpers.ts";

describe("commands helpers", () => {
  describe("guessTier", () => {
    it("classifies expensive paid models (>5) as frontier", () => {
      const m = makeModel("any", "any-model", 10, 5);
      assert.equal(guessTier(m), "frontier");
    });

    it("classifies cheap paid models (<1) as quick", () => {
      const m = makeModel("any", "any-model", 0.5, 0.2);
      assert.equal(guessTier(m), "quick");
    });

    it("classifies middling cost paid models as general", () => {
      const m = makeModel("any", "mid-model", 3, 0);
      assert.equal(guessTier(m), "general");
    });

    it("classifies free models (cost 0) with small context as quick", () => {
      const m = makeModel("ollama", "local-model", 0, 0, 128000);
      assert.equal(guessTier(m), "quick");
    });

    it("classifies free models (cost 0) with >=200k context as general", () => {
      const m = makeModel("ollama", "local-model", 0, 0, 200000);
      assert.equal(guessTier(m), "general");
    });

    it("handles missing cost fields gracefully", () => {
      const m = withoutCost(makeModel("any", "no-cost", 0, 0));
      assert.equal(guessTier(m), "quick");
    });

    it("classifies subscription provider (antigravity) >=200k context as frontier", () => {
      const m = makeModel("antigravity", "sub-model", 3, 1, 200000);
      assert.equal(guessTier(m), "frontier");
    });

    it("classifies subscription provider (openai-codex) >=64k and <200k context as general", () => {
      const m = makeModel("openai-codex", "sub-model", 3, 1, 100000);
      assert.equal(guessTier(m), "general");
    });

    it("classifies subscription provider (openai-codex) <64k context as quick", () => {
      const m = makeModel("openai-codex", "sub-model", 3, 1, 32000);
      assert.equal(guessTier(m), "quick");
    });

    it("only returns known tier names", () => {
      const known = new Set(["quick", "general", "frontier"]);
      const cases = [
        makeModel("free", "free", 0, 0),
        makeModel("cheap", "cheap", 0.5, 0.2),
        makeModel("mid", "mid", 3, 0),
        makeModel("expensive", "expensive", 10, 0),
        makeModel("antigravity", "sub", 3, 1, 200000),
        makeModel("openai-codex", "sub2", 3, 1, 32000),
        withoutCost(makeModel("no-cost", "no-cost", 0, 0)),
      ];
      for (const m of cases) {
        const tier = guessTier(m);
        assert(known.has(tier), `unexpected tier ${tier}`);
      }
    });
  });

  describe("DEFAULT_RULES", () => {
    it("routes only to known tiers", () => {
      const known = new Set(["quick", "general", "writing", "coding", "frontier"]);
      for (const rule of DEFAULT_RULES) {
        assert(known.has(rule.model), `rule routes to unknown tier ${rule.model}`);
      }
    });

    it("routes ordinary development rules to coding, not general", () => {
      const codingOnly = ["unit tests", "refactor this function", "implement the login endpoint",
        "add error handling here", "add types to this function", "call the api for pricing",
        "review this code", "fix bug in the parser"];
      for (const text of codingOnly) {
        const rule = DEFAULT_RULES.find((r) => new RegExp(r.pattern, "i").test(text));
        assert(rule, `no rule matched "${text}"`);
        assert.equal(rule?.model, "coding", `"${text}" routed to ${rule?.model}, expected coding`);
      }
    });

    it("does not route generic 'create a <noun>' prose to coding", () => {
      const prose = ["create a poem about autumn", "write a birthday message"];
      for (const text of prose) {
        const rule = DEFAULT_RULES.find((r) => new RegExp(r.pattern, "i").test(text));
        assert.notEqual(rule?.model, "coding", `"${text}" incorrectly routed to coding`);
      }
    });

    it("routes plan/decompose/orchestrate rules to frontier, not coding", () => {
      const frontierOnly = ["create an implementation plan for this migration", "decompose this project into tasks"];
      for (const text of frontierOnly) {
        const rule = DEFAULT_RULES.find((r) => new RegExp(r.pattern, "i").test(text));
        assert.equal(rule?.model, "frontier", `"${text}" routed to ${rule?.model}, expected frontier`);
      }
    });

    it("routes mixed design+implement prompts to coding", () => {
      const rule = DEFAULT_RULES.find((r) => new RegExp(r.pattern, "i").test("design and implement the payment flow"));
      assert.equal(rule?.model, "coding");
    });

    it("has no default rule pointing at general", () => {
      assert(!DEFAULT_RULES.some((r) => r.model === "general"));
    });
  });

  describe("buildInitProposal", () => {
    it("category strategy keys match model tier keys", () => {
      const proposal = buildInitProposal(
        { quick: [], general: [], frontier: [] },
        "provider/classifier",
        ".",
      ) as { categoryStrategies: Record<string, string>; models: Record<string, string[]> };
      assert.deepEqual(
        Object.keys(proposal.categoryStrategies).sort(),
        Object.keys(proposal.models).sort(),
      );
    });

    it("default matches first populated tier", () => {
      const models = { quick: ["a"], frontier: ["b"] };
      const proposal = buildInitProposal(models, "provider/c", ".") as { default: string };
      assert.equal(proposal.default, "quick");
    });

    it("default falls back to general when models are empty", () => {
      const proposal = buildInitProposal({}, "provider/c", ".") as { default: string };
      assert.equal(proposal.default, "general");
    });
  });

  describe("selectModel with cheapest strategy", () => {
    it("picks lowest input+output cost", () => {
      const a = makeModel("a", "a", 5, 0);
      const b = makeModel("b", "b", 1, 0);
      const c = makeModel("c", "c", 3, 2);
      const selected = selectModel([a, b, c], "cheapest");
      assert.equal(modelKey(selected), "b/b");
    });
  });

  describe("findCandidates with multiple patterns", () => {
    it("deduplicates across exact and substring matches", () => {
      const ctx = makeCtx([
        makeModel("anthropic", "claude-opus"),
        makeModel("anthropic", "claude-sonnet"),
      ]);
      const result = findCandidates(ctx, ["anthropic/claude-opus", "anthropic"]);
      assert.equal(result.length, 2);
    });

    it("returns empty for empty patterns", () => {
      const ctx = makeCtx([]);
      assert.equal(findCandidates(ctx, []).length, 0);
    });
  });

  describe("getStrategy", () => {
    it("falls back through category → global → default", () => {
      assert.equal(getStrategy({ frontier: "cheapest" }, "first", "frontier"), "cheapest");
      assert.equal(getStrategy({}, "first", "economical"), "first");
      assert.equal(getStrategy(undefined, undefined, "economical"), "first");
    });
  });
});
