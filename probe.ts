// ── Model probe: availability testing ────────────────────────────
// Sends a tiny prompt to every available model and records results.
// Used by /bifrost probe to surface real-world model health.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProbeResult {
  provider: string;
  model: string;
  cost_input: number;
  cost_output: number;
  status: "ok" | "error" | "timeout" | "skipped";
  duration_ms: number;
  transport?: "streamSimple" | "session";
  error?: string;
  tokens?: number;
  /** Model transport identity used to invalidate stale successful probes. */
  fingerprint?: string;
  /** Probe completion time used for per-model TTL reuse. */
  probedAt?: number;
}

const PROBE_PROMPT = "1+1=";
export const PROBE_PROMPT_TEXT = PROBE_PROMPT;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_TOKENS = 4;
export const PROBE_RESULT_TTL_MS = 60 * 60_000;

export interface ProbeOptions {
  ttlMs?: number;
  force?: boolean;
  now?: number;
}

function probeFingerprint(model: Model<Api>): string {
  return JSON.stringify([model.provider, model.id, model.api, model.baseUrl]);
}

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export async function runProbe(
  ctx: ExtensionContext,
  onProgress?: (done: number, total: number, last: ProbeResult) => void,
  models?: Model<Api>[],
  options: ProbeOptions = {},
): Promise<{ results: ProbeResult[]; freshResults: ProbeResult[]; path: string; cached: number }> {
  const available = models ?? ctx.modelRegistry.getAvailable();
  const total = available.length;
  const outputPath = join(getAgentDir(), "bifrost-probe.json");
  const ttlMs = options.ttlMs ?? PROBE_RESULT_TTL_MS;
  const now = options.now ?? Date.now();
  const cachedByKey = new Map<string, ProbeResult>();
  const storedByKey = new Map<string, ProbeResult>();

  if (existsSync(outputPath)) {
    try {
      const fileTime = statSync(outputPath).mtimeMs;
      const cached = JSON.parse(readFileSync(outputPath, "utf-8")) as ProbeResult[];
      for (const result of cached) {
        const key = `${result.provider}/${result.model}`;
        storedByKey.set(key, result);
        const probedAt = result.probedAt ?? fileTime;
        if (!options.force && result.status === "ok" && now - probedAt < ttlMs) {
          cachedByKey.set(key, result);
        }
      }
    } catch {
      // Corrupt or unreadable cache: probe normally.
    }
  }

  const results: ProbeResult[] = new Array(total);
  const pending: Array<{ index: number; model: Model<Api> }> = [];
  let completed = 0;
  let cachedCount = 0;
  for (let index = 0; index < total; index++) {
    const model = available[index];
    const cached = cachedByKey.get(`${model.provider}/${model.id}`);
    if (cached?.fingerprint === probeFingerprint(model)) {
      results[index] = cached;
      cachedCount++;
      completed++;
      onProgress?.(completed, total, cached);
    } else {
      pending.push({ index, model });
    }
  }

  const CONCURRENCY = 8;
  const freshResults: ProbeResult[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      const result = await probeOne(ctx, item.model);
      result.fingerprint = probeFingerprint(item.model);
      result.probedAt = now;
      results[item.index] = result;
      freshResults.push(result);
      completed++;
      onProgress?.(completed, total, result);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker());
  await Promise.all(workers);

  if (freshResults.length > 0 || !existsSync(outputPath)) {
    for (const result of results) storedByKey.set(`${result.provider}/${result.model}`, result);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify([...storedByKey.values()], null, 2), "utf-8");
  }
  return { results, freshResults, path: outputPath, cached: cachedCount };
}

async function probeOne(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<ProbeResult> {
  const base: ProbeResult = {
    provider: model.provider,
    model: model.id,
    cost_input: model.cost?.input ?? 0,
    cost_output: model.cost?.output ?? 0,
    status: "skipped",
    duration_ms: 0,
  };

  const api = model.api as string | undefined;
  if (!api) {
    base.error = "unsupported api: undefined";
    return base;
  }

  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) {
        base.status = "error";
        base.error = `unknown provider: ${model.provider}`;
        return base;
      }
      const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
      if (!auth) {
        base.status = "error";
        base.error = "auth unavailable";
        return base;
      }

      const stream = provider.streamSimple(
        model,
        {
          systemPrompt: "Reply only with 2.",
          messages: [{ role: "user", content: PROBE_PROMPT, timestamp: Date.now() }],
        },
        {
          maxTokens: PROBE_MAX_TOKENS,
          signal: controller.signal,
          cacheRetention: "none",
          apiKey: auth.auth.apiKey,
          headers: auth.auth.headers,
          env: auth.env,
        },
      );
      const response = await stream.result();
      base.duration_ms = +(performance.now() - start).toFixed(1);
      const text = assistantText(response).trim();
      const isStreamError = response.stopReason === "error";
      if (isStreamError) {
        base.transport = "streamSimple";
        base.status = "error";
        base.error = response.errorMessage ?? "model error";
        return base;
      }
      if (!text) {
        base.transport = "streamSimple";
        base.status = "ok";
        base.tokens = response.usage.totalTokens;
        return base;
      }
      base.transport = "streamSimple";
      base.status = "ok";
      base.tokens = response.usage.totalTokens;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    base.duration_ms = +(performance.now() - start).toFixed(1);
    base.status = err instanceof DOMException && err.name === "AbortError"
      ? "timeout"
      : "error";
    base.error = String(err).slice(0, 200);
  }

  return base;
}
