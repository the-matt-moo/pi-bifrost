// Real Pi lifecycle gate with in-memory sessions and local fake streams: no paid calls or discovered extensions.
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const bifrost = (await createJiti(import.meta.url).import(join(root, "index.ts"))).default;

for (const mode of ["credits", "session", "no-replacement"]) it(`Pi 1.1.0 fake-provider ${mode} handoff retains completed tools without replay`, { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-host-"));
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedToken = process.env.OPENAI_CODEX_TOKEN;
  const savedFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.OPENAI_CODEX_TOKEN = "fake-test-token";
  let used = 90;
  globalThis.fetch = async (url) => {
    if (String(url) !== "https://chatgpt.com/backend-api/wham/usage") throw new Error("network disabled");
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: used }, secondary_window: { used_percent: 20 } } }));
  };
  writeFileSync(join(dir, "bifrost.json"), JSON.stringify({ enabled: true, silent: true, classifier: { enabled: false }, cache: { enabled: false },
    models: { coding: mode === "no-replacement" ? ["openai-codex/source"] : ["openai-codex/source", "fake-native/target"] }, reliability: { autoRetry: true, maxAutoRetries: 2 } }));
  let sourceCalls = 0, targetCalls = 0, toolCalls = 0;
  const requests = [], lifecycleErrors = [], retries = [];
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, packages: [], extensions: [] });
  const fake = (pi) => {
    const streamSimple = (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        requests.push({ model: `${model.provider}/${model.id}`, messages: structuredClone(context.messages) });
        const source = model.provider === "openai-codex";
        if (source) sourceCalls++; else targetCalls++;
        const first = source && sourceCalls === 1;
        const stopReason = options?.signal?.aborted ? "aborted" : first ? "toolUse" : source ? "error" : "stop";
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
          content: first ? [{ type: "toolCall", id: "completed-write", name: "once", arguments: {} }] : stopReason === "stop" ? [{ type: "text", text: "continued safely" }] : [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          ...(stopReason === "error" ? { errorMessage: "429 {\"type\":\"credits_required\"}" } : {}) };
        stream.push({ type: "start", partial: message });
        if (first) {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
        }
        if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
        else stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
      });
      return stream;
    };
    for (const [name, id] of [["openai-codex", "source"], ["fake-native", "target"]]) pi.registerProvider(name, {
      api: "bifrost-fake", apiKey: "fake-test", baseUrl: "https://example.invalid", streamSimple,
      models: [{ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    });
    pi.registerTool({ name: "once", label: "once", description: "Count a completed side effect", parameters: Type.Object({}),
      execute: async () => { toolCalls++; if (mode !== "credits") used = 96; return { content: [{ type: "text", text: "Completed: edited example.ts once" }], details: undefined }; } });
  };
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Use the once tool exactly once, then finish.", extensionFactories: [fake, bifrost] });
  let session;
  try {
    await loader.reload();
    const source = { provider: "openai-codex", id: "source", name: "source", api: "bifrost-fake", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
    const target = { ...source, provider: "fake-native", id: "target", name: "target" };
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, model: source, scopedModels: [{ model: source }, { model: target }], thinkingLevel: "off",
      resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager, tools: ["once"] }));
    await session.bindExtensions({ mode: "json", onError: (error) => lifecycleErrors.push(error.error) });
    session.subscribe((event) => { if (event.type === "auto_retry_start") retries.push(event); });
    await session.prompt("/bifrost pin");
    await session.prompt("Implement the requested fix");
    assert.deepEqual(lifecycleErrors, []);
    assert.equal(toolCalls, 1, "the completed side effect is never replayed");
    assert.equal(retries.length, 0, "terminal credits are handled before the host's 3 outer retries");
    assert.equal(sourceCalls, mode === "credits" ? 2 : 1, "session exhaustion changes model before the next provider call");
    assert.equal(targetCalls, mode === "no-replacement" ? 0 : 1);
    assert.equal(session.messages.filter((m) => m.role === "user").length, 1, "original user prompt appears only once");
    assert.equal(session.sessionManager.getBranch().some((e) => e.customType === "bifrost-handoff"), false, "Markdown document is never persisted");
    if (mode !== "no-replacement") {
      const messages = requests.at(-1).messages;
      assert.ok(messages.some((m) => m.role === "toolResult" && m.toolCallId === "completed-write"));
      assert.ok(messages.some((m) => JSON.stringify(m.content).includes("# Bifrost session handoff")));
      assert.match(JSON.stringify(messages), /edited example.ts once/);
      assert.equal(session.model.provider, "fake-native");
    }
  } finally {
    session?.dispose();
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedToken === undefined) delete process.env.OPENAI_CODEX_TOKEN; else process.env.OPENAI_CODEX_TOKEN = savedToken;
    globalThis.fetch = savedFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
