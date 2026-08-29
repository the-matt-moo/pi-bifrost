import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessThinking,
  clampToModel,
  ThinkingSession,
  type ThinkingSignals,
} from "../thinking.ts";

function signals(text: string, overrides: Partial<ThinkingSignals> = {}): ThinkingSignals {
  return {
    text,
    turnDepth: 1,
    lastTurnFailed: false,
    lastTurnErrored: false,
    ...overrides,
  };
}

describe("thinking", () => {
  it("scores reasoning intent at +3", () => {
    const result = assessThinking(signals("design an algorithm for this parser"));
    assert.equal(result.score, 3);
    assert.equal(result.level, "high");
    assert.ok(result.reasons.includes("+3 reasoning-intent"));
  });

  it("scores diagnostic intent at +2", () => {
    const result = assessThinking(signals("debug the flaky regression"));
    assert.equal(result.score, 2);
    assert.equal(result.level, "medium");
    assert.ok(result.reasons.includes("+2 diagnostic"));
  });

  it("scores multi-step intent at +1", () => {
    const result = assessThinking(signals("compare these alternatives"));
    assert.equal(result.score, 1);
    assert.equal(result.level, "medium");
    assert.ok(result.reasons.includes("+1 multi-step"));
  });

  it("demotes mechanical work to minimal", () => {
    const result = assessThinking(signals("fix the typo in README.md"));
    assert.equal(result.score, -3);
    assert.equal(result.level, "minimal");
  });

  it("defaults unknown prompts to medium rather than low", () => {
    const result = assessThinking(signals("continue"));
    assert.equal(result.level, "medium");
    assert.equal(result.score, 0);
    assert.equal(result.defaulted, true);
    assert.deepEqual(result.reasons, []);
  });

  it("escalates a failed correction above medium", () => {
    const result = assessThinking(signals("still broken", { lastTurnFailed: true }));
    assert.ok(result.score >= 3);
    assert.ok(["high", "xhigh"].includes(result.level));
    assert.ok(result.reasons.includes("+2 previous-turn-failed"));
    assert.ok(result.reasons.includes("+2 correction"));
  });

  it("escalates a deep continuation above medium", () => {
    const result = assessThinking(signals("continue", { turnDepth: 4 }));
    assert.equal(result.level, "medium");
    assert.ok(result.reasons.includes("+1 task-depth"));
  });

  it("combines structural signals", () => {
    const result = assessThinking(signals("why is this failing? Check a.ts, b.ts, and c.ts?", {
      turnDepth: 3,
      lastTurnFailed: true,
      lastTurnErrored: true,
    }));
    assert.ok(result.score >= 6);
    assert.equal(result.level, "xhigh");
    assert.ok(result.reasons.length > 0);
  });

  it("keeps a level sticky for a same-topic follow-up", () => {
    const session = new ThinkingSession();
    session.record("high", "debug the parser failure in parser.ts");
    assert.equal(session.suggest("continue debugging the parser failure"), "high");
  });

  it("does not carry a level across a topic change", () => {
    const session = new ThinkingSession();
    session.record("high", "debug the parser failure in parser.ts");
    assert.equal(session.suggest("write a short changelog for the release"), undefined);
  });

  it("can preview a topic change without clearing sticky state", () => {
    const session = new ThinkingSession();
    session.record("high", "debug the parser failure in parser.ts");
    assert.equal(session.suggest("write a short changelog", false), undefined);
    assert.equal(session.suggest("continue debugging the parser failure"), "high");
  });

  it("tracks same-topic turn depth", () => {
    const session = new ThinkingSession();
    session.record("medium", "debug the parser failure");
    session.record("high", "continue debugging the parser failure");
    assert.equal(session.turnDepth("fix the parser failure now"), 3);
  });

  it("clamps non-reasoning models to off", () => {
    const result = clampToModel("high", { reasoning: false });
    assert.deepEqual(result, {
      level: "off",
      clamped: true,
      reason: "model does not support reasoning",
    });
  });

  it("steps down unsupported mapped levels", () => {
    const result = clampToModel("xhigh", {
      reasoning: true,
      thinkingLevelMap: { xhigh: null, high: 1 },
    });
    assert.deepEqual(result, {
      level: "high",
      clamped: true,
      reason: "xhigh unsupported by model",
    });
  });

  it("keeps supported levels unchanged", () => {
    assert.deepEqual(clampToModel("medium", { reasoning: true }), {
      level: "medium",
      clamped: false,
    });
  });

  it("maximizes free-model thinking to the highest supported level", () => {
    assert.deepEqual(clampToModel("minimal", {
      reasoning: true,
      thinkingLevelMap: { max: null, xhigh: null, high: 1 },
    }, true), {
      level: "high",
      clamped: true,
      reason: "max unsupported by model",
    });
  });

  it("scores a 100 KB prompt under 20 microseconds", () => {
    const text = "x ".repeat(50000);
    const input = signals(text);
    for (let i = 0; i < 1000; i++) assessThinking(input);

    const iterations = 5000;
    const samples: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      const start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) assessThinking(input);
      samples.push(Number(process.hrtime.bigint() - start) / iterations / 1000);
    }
    samples.sort((a, b) => a - b);
    const medianMicroseconds = samples[1];
    assert.ok(
      medianMicroseconds < 20,
      `median score time ${medianMicroseconds.toFixed(3)}µs exceeded 20µs (samples: ${samples.map((value) => value.toFixed(3)).join(", ")})`,
    );
  });

  it("always explains non-default decisions", () => {
    for (const text of ["fix the typo", "debug this", "plan the migration", "still broken"]) {
      const result = assessThinking(signals(text, { lastTurnFailed: text === "still broken" }));
      assert.ok(result.score !== 0);
      assert.ok(result.reasons.length > 0);
    }
  });
});
