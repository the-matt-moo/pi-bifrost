import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeReliabilityTracker } from "../runtime-reliability.ts";

const failed = (reason = "Streaming response failed", content: unknown[] = []) => ({
  role: "assistant",
  provider: "openai",
  model: "gpt-5.4",
  stopReason: "error",
  errorMessage: reason,
  content,
});
const succeeded = { role: "assistant", provider: "openai", model: "gpt-5.4", stopReason: "stop" };

describe("runtime reliability tracker", () => {
  it("reports final stream failure for selected model only after settlement", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([failed()]);
    assert.deepEqual(tracker.settle(), {
      model: "openai/gpt-5.4",
      reason: "Streaming response failed",
      replaySafe: true,
      retry: undefined,
    });
  });

  it("does not report failure when Pi retry succeeds", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([failed()]);
    tracker.observe([succeeded]);
    assert.deepEqual(tracker.settle(), {
      model: "openai/gpt-5.4",
      reason: undefined,
      replaySafe: false,
      retry: undefined,
    });
  });

  it("preserves retry context for a provider rejection with no side effects", () => {
    const tracker = new RuntimeReliabilityTracker();
    const retry = { prompt: "fix the bug", tier: "frontier", autoRetryCount: 0 };
    tracker.begin("openai/gpt-5.4", retry);
    tracker.observe([failed("429: temporarily rate-limited upstream")]);
    assert.deepEqual(tracker.settle(), {
      model: "openai/gpt-5.4",
      reason: "429: temporarily rate-limited upstream",
      replaySafe: true,
      retry,
    });
  });

  it("blocks replay after assistant output or a tool result", () => {
    const withOutput = new RuntimeReliabilityTracker();
    withOutput.begin("openai/gpt-5.4");
    withOutput.observe([failed("429", [{ type: "text", text: "partial" }])]);
    assert.equal(withOutput.settle()?.replaySafe, false);

    const withTool = new RuntimeReliabilityTracker();
    withTool.begin("openai/gpt-5.4");
    withTool.observe([failed("429")]);
    withTool.noteToolResults([{}]);
    assert.equal(withTool.settle()?.replaySafe, false);
  });

  it("ignores failures from models Bifrost did not select", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([{ ...failed(), model: "gpt-4.1-mini" }]);
    assert.deepEqual(tracker.settle(), {
      model: "openai/gpt-5.4",
      reason: undefined,
      replaySafe: false,
      retry: undefined,
    });
  });
});
