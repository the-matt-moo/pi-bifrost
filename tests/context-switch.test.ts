import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prepareContextSwitch, projectedContextPercent } from "../context-switch.ts";

describe("context-safe model switching", () => {
  it("uses the target model window", () => {
    assert.equal(projectedContextPercent(200_000, 1_000_000), 20);
    assert.equal(projectedContextPercent(200_000, 128_000), 156.25);
  });

  it("waits for compaction completion before allowing the switch", async () => {
    let complete: (() => void) | undefined;
    const messages: string[] = [];
    const pending = prepareContextSwitch(
      {
        getContextUsage: () => ({ tokens: 80_000, percent: 20 }),
        compact: ({ onComplete }) => { complete = () => onComplete?.({}); },
      },
      { contextWindow: 100_000 },
      {
        enabled: true,
        thresholdPercent: 60,
        targetLabel: "provider/model",
        notify: (message) => messages.push(message),
      },
    );

    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    complete?.();
    assert.equal(await pending, true);
    assert.ok(messages.some((message) => message.includes("compacting before switch")));
  });

  it("blocks the switch when compaction fails", async () => {
    const allowed = await prepareContextSwitch(
      {
        getContextUsage: () => ({ tokens: 80_000 }),
        compact: ({ onError }) => onError?.(new Error("offline")),
      },
      { contextWindow: 100_000 },
      {
        enabled: true,
        thresholdPercent: 60,
        targetLabel: "provider/model",
        notify: () => undefined,
      },
    );

    assert.equal(allowed, false);
  });
});
