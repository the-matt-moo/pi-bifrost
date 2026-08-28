import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  billingClass,
  selectModel,
  selectWeighted,
  subscriptionWeights,
} from "../routing.ts";
import { QuotaStore, type QuotaSnapshot } from "../quota.ts";

function model(provider: string, id: string, cost = 1): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: cost, output: cost, cacheRead: cost, cacheWrite: cost },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function snapshot(now: number, entries: [string, number][], hours: number[] = []): QuotaSnapshot {
  const byProvider: QuotaSnapshot["byProvider"] = {};
  entries.forEach(([provider, remaining], i) => {
    byProvider[provider] = { weeklyRemainingFraction: remaining, hoursToReset: hours[i] };
  });
  return { byProvider, fetchedAt: now };
}

/** Run a synchronous pick with Math.random pinned to `rand`. */
function withRandom<T>(rand: number, fn: () => T): T {
  const orig = Math.random;
  Math.random = () => rand;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

const NOW = 1_000_000_000_000;
const FRESH = { gamma: 3, reservePercent: 0.03, staleMinutes: 15 };

describe("QuotaStore refresh backoff", () => {
  it("backs off after an empty quota result", async () => {
    let calls = 0;
    const store = new QuotaStore({ refreshMinutes: 30 }, async () => {
      calls++;
      return [undefined, undefined, undefined];
    });
    await store.refreshIfStale(1_000);
    await store.refreshIfStale(2_000);
    assert.equal(calls, 1);
    await store.refreshIfStale(1_000 + 30 * 60_000);
    assert.equal(calls, 2);
  });
});

describe("billingClass", () => {
  it("classifies cost-free models as free first", () => {
    assert.equal(billingClass(model("openrouter", "x-free", 0)), "free");
  });
  it("classifies subscription providers", () => {
    assert.equal(billingClass(model("openai-codex", "gpt")), "subscription");
    assert.equal(billingClass(model("antigravity", "gemini")), "subscription");
  });
  it("classifies OpenRouter-compatible hubs as paid credit", () => {
    assert.equal(billingClass(model("openrouter", "paid")), "paid-credit");
    assert.equal(billingClass(model("opencode-go", "glm")), "paid-credit");
  });
  it("treats unknown and pay-as-you-go Google providers neutrally", () => {
    assert.equal(billingClass(model("some-provider", "x")), "unknown");
    assert.equal(billingClass(model("google-vertex-ai", "gemini")), "unknown");
  });
});

describe("subscriptionWeights", () => {
  it("favors the subscription provider with more remaining allowance", () => {
    const codex = model("openai-codex", "codex");
    const antigravity = model("antigravity", "gemini");
    const weights = subscriptionWeights(
      [codex, antigravity],
      snapshot(NOW, [["openai-codex", 0.1], ["antigravity", 0.8]]),
      FRESH,
      NOW,
    );
    assert.ok(weights[1] > weights[0]);
    assert.ok(Math.abs(weights[1] - 0.512) < 1e-9); // 0.8^3
  });

  it("converges toward even as allowances approach equilibrium", () => {
    const a = model("openai-codex", "codex");
    const b = model("antigravity", "gemini");
    const near = subscriptionWeights(
      [a, b],
      snapshot(NOW, [["openai-codex", 0.55], ["antigravity", 0.45]]),
      FRESH,
      NOW,
    );
    // 0.55^3=0.166 vs 0.45^3=0.091 — neither dominant
    const ratio = near[0] / near[1];
    assert.ok(ratio > 1 && ratio < 3, `expected near-even ratio, got ${ratio}`);
  });

  it("blocks paid OpenRouter while any subscription has allowance above reserve", () => {
    const codex = model("openai-codex", "codex");
    const or = model("openrouter", "paid");
    const weights = subscriptionWeights(
      [codex, or],
      snapshot(NOW, [["openai-codex", 0.4]]),
      FRESH,
      NOW,
    );
    assert.equal(weights[1], 0);
  });

  it("unblocks paid OpenRouter once subscriptions are drained below reserve", () => {
    const codex = model("openai-codex", "codex");
    const antigravity = model("antigravity", "gemini");
    const or = model("openrouter", "paid");
    const weights = subscriptionWeights(
      [codex, antigravity, or],
      snapshot(NOW, [["openai-codex", 0.01], ["antigravity", 0.02]]),
      FRESH,
      NOW,
    );
    assert.equal(weights[2], 1);
    assert.equal(weights[0], 0.05); // drained subs keep a tiny floor
    assert.equal(weights[1], 0.05);
  });

  it("keeps free models usable and neutral", () => {
    const codex = model("openai-codex", "codex");
    const free = model("openrouter", "flash-free", 0);
    const weights = subscriptionWeights(
      [codex, free],
      snapshot(NOW, [["openai-codex", 0.9]]),
      FRESH,
      NOW,
    );
    assert.equal(weights[1], 1);
  });

  it("never lets an unmeasured subscription outrank a measured healthy one", () => {
    const codex = model("openai-codex", "codex");
    const antigravity = model("antigravity", "gemini");
    // codex measured at 0.9 (0.729); antigravity has no telemetry -> 0.5
    const weights = subscriptionWeights(
      [codex, antigravity],
      snapshot(NOW, [["openai-codex", 0.9]]),
      FRESH,
      NOW,
    );
    assert.ok(Math.abs(weights[0] - 0.729) < 1e-9);
    assert.equal(weights[1], 0.5);
    assert.ok(weights[0] > weights[1]);
  });

  it("degrades to neutral all-ones with stale or empty telemetry", () => {
    const codex = model("openai-codex", "codex");
    const antigravity = model("antigravity", "gemini");
    const or = model("openrouter", "paid");
    const stale = subscriptionWeights(
      [codex, antigravity, or],
      snapshot(NOW - 2_000_000_000, [["openai-codex", 0.1], ["antigravity", 0.8]]),
      FRESH,
      NOW,
    );
    assert.deepEqual(stale, [1, 1, 1]);

    const empty = subscriptionWeights([codex, or], { byProvider: {}, fetchedAt: NOW }, FRESH, NOW);
    assert.deepEqual(empty, [1, 1]);
  });
});

describe("selectWeighted", () => {
  it("never picks a zero-weight item", () => {
    const items = ["a", "b"];
    const picks = new Set<string>();
    for (let i = 0; i < 50; i++) picks.add(selectWeighted(items, [1, 0])!);
    assert.deepEqual([...picks], ["a"]);
  });
  it("degenerates to uniform when all weights are zero", () => {
    const items = ["a", "b"];
    assert.ok(items.includes(selectWeighted(items, [0, 0])!));
  });
});

describe("selectModel weekly quota preference", () => {
  it("prefers the subscription provider with over 10% more weekly allowance", () => {
    const codex = model("openai-codex", "codex");
    const antigravity = model("antigravity", "gemini");
    const quota = snapshot(NOW, [["openai-codex", 0.4], ["antigravity", 0.8]]); // 40% gap
    const got = selectModel([codex, antigravity], "subscription_balance", quota, FRESH, NOW);
    assert.equal(got?.provider, "antigravity");
    assert.equal(selectModel([codex, antigravity], "first", quota, FRESH, NOW)?.provider, "openai-codex");
  });

  it("uses the normal strategy when weekly allowances are within 10%", () => {
    const codex = model("openai-codex", "codex");
    const antigravity = model("antigravity", "gemini");
    const quota = snapshot(NOW, [["openai-codex", 0.6], ["antigravity", 0.65]]); // 5% gap

    assert.equal(selectModel([codex, antigravity], "first", quota, FRESH, NOW)?.provider, "openai-codex");
    const balanced = withRandom(0.49, () =>
      selectModel([codex, antigravity], "subscription_balance", quota, FRESH, NOW),
    );
    assert.equal(balanced?.provider, "openai-codex");
  });
});

describe("selectModel subscription_balance", () => {
  it("routes to the high-allowance subscription provider", () => {
    const codex = model("openai-codex", "codex");
    const antigravity = model("antigravity", "gemini");
    // weights [0.001, 0.512], sum 0.513; rand 0.5 → r=0.2565 → lands in antigravity
    const got = withRandom(0.5, () =>
      selectModel(
        [codex, antigravity],
        "subscription_balance",
        snapshot(NOW, [["openai-codex", 0.1], ["antigravity", 0.8]]),
        FRESH,
        NOW,
      ),
    );
    assert.equal(got?.provider, "antigravity");
  });

  it("falls back to paid credit only when subscriptions are drained", () => {
    const codex = model("openai-codex", "codex");
    const or = model("openrouter", "paid");
    // weights [0.05, 1], sum 1.05; rand 0.5 → r=0.525 → lands in openrouter
    const got = withRandom(0.5, () =>
      selectModel(
        [codex, or],
        "subscription_balance",
        snapshot(NOW, [["openai-codex", 0.01]]),
        FRESH,
        NOW,
      ),
    );
    assert.equal(got?.provider, "openrouter");
  });
});

describe("selectModel subscription_preferred", () => {
  it("prioritizes subscription models over paid-credit when available", () => {
    const codex = model("openai-codex", "codex");
    const or = model("openrouter", "paid");
    const quota = snapshot(NOW, [["openai-codex", 0.5]]);
    const got = selectModel([codex, or], "subscription_preferred", quota, FRESH, NOW);
    assert.equal(got?.provider, "openai-codex");
  });

  it("falls back to free models when no subscription models available", () => {
    const free = model("openrouter", "flash-free", 0);
    const or = model("openrouter", "paid");
    const got = selectModel([free, or], "subscription_preferred", { byProvider: {}, fetchedAt: NOW }, FRESH, NOW);
    assert.equal(got?.provider, "openrouter");
    assert.equal(got?.id, "flash-free");
  });

  it("falls back to paid-credit when no subscription or free models available", () => {
    const or = model("openrouter", "paid");
    const got = selectModel([or], "subscription_preferred", { byProvider: {}, fetchedAt: NOW }, FRESH, NOW);
    assert.equal(got?.provider, "openrouter");
  });

  it("balances subscription providers within 10% using quota weights", () => {
    const codex = model("openai-codex", "codex");
    const antigravity = model("antigravity", "gemini");
    const quota = snapshot(NOW, [["openai-codex", 0.3], ["antigravity", 0.9]]);
    // subscription_preferred should use quota weights and pick antigravity (high allowance)
    const got = withRandom(0.5, () =>
      selectModel([codex, antigravity], "subscription_preferred", quota, FRESH, NOW),
    );
    assert.equal(got?.provider, "antigravity");
  });

  it("includes Anthropic as a subscription provider", () => {
    const anthropic = model("anthropic", "claude");
    const or = model("openrouter", "paid");
    const quota = snapshot(NOW, [["anthropic", 0.7]]);
    const got = selectModel([anthropic, or], "subscription_preferred", quota, FRESH, NOW);
    assert.equal(got?.provider, "anthropic");
  });
});
