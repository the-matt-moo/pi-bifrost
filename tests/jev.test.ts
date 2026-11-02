import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyWithLLM,
  clipTopicPrompt,
  jevClassifierForReference,
  jevRequest,
  jevTopicRequest,
  judgeTopicWithJev,
  parseTopicAnswer,
  type JevClassifier,
} from "../classifier.ts";
import { createPipeline } from "../classification-pipeline.ts";

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

function context(openRouterKey: string): ExtensionContext {
  return {
    modelRegistry: {
      getProviderAuth: async (provider: string) => provider === "openrouter"
        ? { auth: { apiKey: openRouterKey }, env: {} }
        : undefined,
    },
  } as unknown as ExtensionContext;
}

describe("Jev classifier", () => {
  it("registers direct TypeSafe and OpenRouter decision models", () => {
    assert.deepEqual(jevClassifierForReference("typesafe/jev-latest", "custom-target"), {
      kind: "jev",
      id: "typesafe/jev-latest",
      provider: "typesafe",
      model: "jev-latest",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      credentialTarget: "custom-target",
    });
    assert.deepEqual(jevClassifierForReference("openrouter/~typesafe/jev-latest"), {
      kind: "jev",
      id: "openrouter/~typesafe/jev-latest",
      provider: "openrouter",
      model: "~typesafe/jev-latest",
      endpoint: "https://openrouter.ai/api/alpha/decisions",
    });
  });

  it("uses Jev's native choice schema with category descriptions", () => {
    const model = jevClassifierForReference("typesafe/jev-latest");
    assert.ok(model);
    assert.deepEqual(jevRequest(model, ["quick", "coding"], "fix the parser", {
      quick: "trivial work",
      coding: "implementation and debugging",
    }), {
      state: "fix the parser",
      model: "jev-latest",
      questions: {
        category: {
          type: "choice",
          instructions: {
            task: "Choose the single pi-bifrost routing category that best fits the request.",
            priority: "Classify by the hardest and most consequential requested work.",
          },
          criteria: {
            quick: "trivial work",
            coding: "implementation and debugging",
          },
        },
        isTrivial: {
          type: "noul",
          instructions:
            "The request can be fully satisfied with a one-line command, a simple lookup, or a single trivial file change.",
        },
        effort: {
          type: "score",
          instructions:
            "How much cognitive reasoning depth does this task require?",
          criteria: [
            "Simple search, lookup, or trivial one-line change",
            "Standard implementation, debugging, or refactoring",
            "Complex multi-file architecture, distributed systems, or security analysis",
          ],
        },
      },
    });
  });

  it("falls back from direct Jev to OpenRouter Jev with provider-specific credentials", async (t) => {
    const directKey = randomUUID();
    const openRouterKey = randomUUID();
    const calls: string[] = [];
    const server = await listen((request, response) => {
      calls.push(request.url ?? "");
      const expectedKey = request.url === "/typesafe" ? directKey : openRouterKey;
      assert.equal(request.headers.authorization, `Bearer ${expectedKey}`);
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/typesafe") {
        response.statusCode = 503;
        response.end("{}");
        return;
      }
      response.end(JSON.stringify({
        model: "typesafe/jev-1.13",
        answers: {
          category: {
            type: "choice",
            choice: "coding",
            probabilities: { quick: 0.01, coding: 0.99 },
            confidence: 0.98,
          },
        },
      }));
    });
    t.after(server.close);

    const primary: JevClassifier = {
      kind: "jev",
      id: "typesafe/jev-latest",
      provider: "typesafe",
      model: "jev-latest",
      endpoint: `${server.url}/typesafe`,
      credentialTarget: "test-target",
    };
    const fallback: JevClassifier = {
      kind: "jev",
      id: "openrouter/~typesafe/jev-latest",
      provider: "openrouter",
      model: "~typesafe/jev-latest",
      endpoint: `${server.url}/openrouter`,
    };
    const ctx = context(openRouterKey);
    const pipeline = createPipeline({
      cacheLookup: () => undefined,
      classifierModels: [primary, fallback],
      classifyWithLLM: (model, prompt, tiers, signal) => classifyWithLLM(ctx, model, tiers, prompt, {
        confidenceThreshold: 0.4,
        credentialReader: async (target) => target === "test-target" ? directKey : undefined,
        signal,
        tierDescriptions: { quick: "trivial work", coding: "implementation and debugging" },
      }),
      regexRules: [],
      defaultTier: "quick",
      tiers: ["quick", "coding"],
      complexityEnabled: false,
      classifierMaxAttempts: 2,
    });

    assert.deepEqual(await pipeline.classify("fix the parser"), {
      kind: "classified",
      tier: "coding",
      source: "classifier",
      jevEffort: undefined,
    });
    assert.deepEqual(calls, ["/typesafe", "/openrouter"]);
  });

  it("topic request is one Choice question with bounded, JSON-encoded user prompts", () => {
    const model = jevClassifierForReference("typesafe/jev-latest");
    assert.ok(model);
    const body = jevTopicRequest(model, ["a".repeat(5000), "b", "c", "d", "e"], "z".repeat(9000)) as {
      model: string; state: string; questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(Object.keys(body.questions), ["topic"]);
    assert.equal(body.questions.topic.type, "choice");
    assert.deepEqual(Object.keys(body.questions.topic.criteria), ["continue", "switch"]);
    const state = JSON.parse(body.state) as { earlierUserPrompts: string[]; currentUserPrompt: string };
    assert.equal(state.earlierUserPrompts.length, 4, "anchor plus three recent prompts");
    assert.ok(state.earlierUserPrompts[0].length <= 1_100);
    assert.ok(state.currentUserPrompt.length <= 4_100);
  });

  it("clips topic prompts idempotently within the bound", () => {
    const once = clipTopicPrompt("q".repeat(5000));
    assert.ok(once.length <= 1000);
    assert.equal(clipTopicPrompt(once), once);
    assert.equal(clipTopicPrompt("short"), "short");
    assert.ok(clipTopicPrompt("q".repeat(9000), 4000).length <= 4000);
  });

  it("accepts only a known choice with documented [0,1] confidence", () => {
    const topic = (value: object) => ({ answers: { topic: value } });
    assert.deepEqual(parseTopicAnswer(topic({ type: "choice", choice: "switch", confidence: 0.93 })), { choice: "switch", confidence: 0.93 });
    assert.deepEqual(parseTopicAnswer(topic({ choice: "continue", confidence: 0 })), { choice: "continue", confidence: 0 });
    for (const bad of [
      null, {}, { answers: {} }, topic({ choice: "maybe", confidence: 0.9 }), topic({ choice: "switch" }),
      topic({ choice: "switch", confidence: null }), topic({ choice: "switch", confidence: Number.NaN }),
      topic({ choice: "switch", confidence: 1.01 }), topic({ choice: "switch", probabilities: { switch: 0.99 } }),
      topic({ type: "noul", choice: "switch", confidence: 0.9 }),
    ]) assert.equal(parseTopicAnswer(bad), undefined, JSON.stringify(bad));
  });

  it("tries direct TypeSafe before OpenRouter and bounds attempts and time", async (t) => {
    const directKey = randomUUID();
    const openRouterKey = randomUUID();
    const calls: string[] = [];
    const oldFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = oldFetch; });
    let mode: "fail-direct" | "hang" = "fail-direct";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      if (mode === "hang") return new Promise(() => {});
      if (url.endsWith("/typesafe")) return new Response("{}", { status: 503 });
      return Response.json({ answers: { topic: { type: "choice", choice: "continue", confidence: 0.97 } } });
    }) as typeof fetch;
    const direct: JevClassifier = { kind: "jev", id: "typesafe/jev-latest", provider: "typesafe", model: "jev-latest", endpoint: "http://fake/typesafe", credentialTarget: "t" };
    const router: JevClassifier = { kind: "jev", id: "openrouter/~typesafe/jev-latest", provider: "openrouter", model: "~typesafe/jev-latest", endpoint: "http://fake/openrouter" };
    const options = { timeoutMs: 50, maxAttempts: 2, credentialReader: async (target: string) => target === "t" ? directKey : undefined };

    assert.deepEqual(await judgeTopicWithJev(context(openRouterKey), [direct, router], ["fix parser"], "add tests", options),
      { status: "decided", choice: "continue", confidence: 0.97, model: router.id });
    assert.deepEqual(calls, [`http://fake/typesafe Bearer ${directKey}`, `http://fake/openrouter Bearer ${openRouterKey}`]);

    calls.length = 0;
    assert.deepEqual(await judgeTopicWithJev(context(openRouterKey), [direct, router], ["x"], "y", { ...options, maxAttempts: 1 }),
      { status: "failed", reason: "HTTP 503" });
    assert.equal(calls.length, 1);

    calls.length = 0;
    mode = "hang";
    const started = Date.now();
    assert.deepEqual(await judgeTopicWithJev(context(openRouterKey), [direct, router], ["x"], "y", options), { status: "failed", reason: "timeout" });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(calls.length, 1, "no further attempts after the shared budget expires");

    mode = "fail-direct";
    calls.length = 0;
    assert.deepEqual(await judgeTopicWithJev(context(openRouterKey), [direct, router], ["x"], "y",
      { ...options, maxAttempts: 1, credentialReader: async () => undefined }),
    { status: "decided", choice: "continue", confidence: 0.97, model: router.id }, "missing direct key does not spend the only attempt");
    assert.deepEqual(calls, [`http://fake/openrouter Bearer ${openRouterKey}`]);

    assert.deepEqual(await judgeTopicWithJev(context(openRouterKey), [], ["x"], "y", options), { status: "failed", reason: "no Jev classifier configured" });
    calls.length = 0;
    assert.deepEqual(await judgeTopicWithJev(context(""), [direct], ["x"], "y", { ...options, credentialReader: async () => undefined }),
      { status: "failed", reason: "no Jev credentials" });
    assert.equal(calls.length, 0);
  });
});
