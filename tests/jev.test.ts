import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyWithLLM,
  jevClassifierForReference,
  jevRequest,
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
    });
    assert.deepEqual(calls, ["/typesafe", "/openrouter"]);
  });
});
