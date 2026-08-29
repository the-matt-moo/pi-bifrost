import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categoryLabel,
  classificationPrompt,
  extractCategory,
  parseAttempt,
  parseClassification,
} from "../classifier.ts";

describe("classifier", () => {
  describe("categoryLabel", () => {
    it("returns category name unchanged", () => {
      assert.equal(categoryLabel("frontier"), "frontier");
      assert.equal(categoryLabel("economical"), "economical");
      assert.equal(categoryLabel("local"), "local");
    });
  });

  describe("classificationPrompt", () => {
    it("lists categories by name", () => {
      const prompt = classificationPrompt(["frontier", "economical"], "hello");
      assert.ok(prompt.includes("frontier, economical"));
      assert.ok(prompt.includes("Request: hello"));
      assert.ok(prompt.includes("Output <category>"));
    });

    it("requires confidence only when requested", () => {
      const prompt = classificationPrompt(["frontier"], "hello", undefined, true);
      assert.ok(prompt.includes("<confidence 0.0-1.0>"));
    });

    it("bounds classifier input while preserving its beginning and end", () => {
      const request = `START${"x".repeat(9_000)}END`;
      const prompt = classificationPrompt(["frontier"], request);
      assert.ok(prompt.includes("START"));
      assert.ok(prompt.includes("END"));
      assert.ok(prompt.includes("middle omitted"));
      assert.ok(prompt.length < request.length);
    });
  });

  describe("parseClassification", () => {
    it("does not invent confidence when omitted", () => {
      assert.deepEqual(parseClassification("frontier", ["frontier"]), {
        tier: "frontier",
        confidence: undefined,
      });
    });

    it("parses decimal confidence", () => {
      assert.deepEqual(parseClassification("frontier 0.8", ["frontier"]), {
        tier: "frontier",
        confidence: 0.8,
      });
    });

    it("rejects missing or low confidence when gating is enabled", () => {
      assert.deepEqual(parseAttempt("frontier", ["frontier"], 0.4), { status: "rejected" });
      assert.deepEqual(parseAttempt("frontier 0.3", ["frontier"], 0.4), { status: "rejected" });
      assert.deepEqual(parseAttempt("frontier 0.8", ["frontier"], 0.4), {
        status: "accepted",
        tier: "frontier",
      });
    });
  });

  describe("extractCategory", () => {
    it("extracts exact category name", () => {
      assert.equal(extractCategory("frontier", ["frontier", "economical"]), "frontier");
    });

    it("is case-insensitive", () => {
      assert.equal(extractCategory("Frontier", ["frontier", "economical"]), "frontier");
    });

    it("handles surrounding whitespace", () => {
      assert.equal(extractCategory("  economical  ", ["frontier", "economical"]), "economical");
    });

    it("returns undefined for non-matching text", () => {
      assert.equal(extractCategory("unknown", ["frontier", "economical"]), undefined);
    });

    it("does not substring match", () => {
      // "not economical" should not match "economical"
      assert.equal(extractCategory("not economical", ["frontier", "economical"]), undefined);
    });
  });
});
