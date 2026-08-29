import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { debug } from "./debug.ts";
import { parseClassifierStderr, formatDiagnostic } from "./diagnostics.ts";

// ── Classifier model — union type, no type-cast lies ─────────

/** A model from pi's registry — full auth, provider support. */
interface RegistryClassifier {
  readonly kind: "registry";
  readonly model: Model<Api>;
}

/** A direct HTTP endpoint — no auth, OpenAI-compatible only. */
interface EndpointClassifier {
  readonly kind: "endpoint";
  readonly id: string;
  readonly baseUrl: string;
}

/** Union: either a registry model or a raw endpoint. */
export type ClassifierModel = RegistryClassifier | EndpointClassifier;

function classifierBaseUrl(cm: ClassifierModel): string {
  return cm.kind === "endpoint" ? cm.baseUrl : cm.model.baseUrl;
}

function classifierId(cm: ClassifierModel): string {
  return cm.kind === "registry" ? cm.model.id : cm.id;
}

function isOpenAiCompatibleEndpoint(cm: ClassifierModel): boolean {
  if (cm.kind === "endpoint") return true; // endpoint config implies OpenAI-compatible
  const api = cm.model.api;
  return (
    api === "openai-completions" ||
    api === "openai-responses" ||
    api === "openai-codex-responses" ||
    api === "azure-openai-responses" ||
    api === "mistral-conversations"
  );
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a routing classifier. Follow the requested output format exactly.";
const DEFAULT_MAX_TOKENS = 8;
const MAX_CLASSIFIER_PROMPT_CHARS = 8_000;

export type ClassifierAttempt =
  | { readonly status: "accepted"; readonly tier: string }
  | { readonly status: "rejected" }
  | { readonly status: "failed" };

export interface ClassifierOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  method?: "direct" | "subprocess" | "auto";
  tierDescriptions?: Record<string, string>;
  signal?: AbortSignal;
  /** Minimum accepted confidence (0-1). Responses below this are treated as
   *  a reject, so routing falls through to regex/fallback and the current
   *  model stays stable. 0 = accept any confidently-tagged tier. */
  confidenceThreshold?: number;
}

/** Parse `tier` or `tier <confidence>` without inventing missing confidence. */
export function parseClassification(text: string, categories: readonly string[]): {
  tier?: string;
  confidence?: number;
} {
  const t = text.trim();
  const confMatch = t.match(/(\d?\d(?:\.\d+)?)\s*%?$/u);
  let confidence: number | undefined;
  let body = t;
  if (confMatch) {
    const num = Number(confMatch[1]);
    const parsed = num > 1 ? num / 100 : num;
    if (parsed >= 0 && parsed <= 1) {
      confidence = parsed;
      body = t.slice(0, confMatch.index ?? 0).trim();
    }
  }
  const tier = extractCategory(body, categories);
  return { tier, confidence };
}

export function categoryLabel(category: string): string {
  return category;
}

export function classificationPrompt(
  categories: readonly string[],
  userPrompt: string,
  tierDescriptions?: Record<string, string>,
  requireConfidence = false,
): string {
  const categoryList = tierDescriptions
    ? categories.map((c) => {
        const desc = tierDescriptions[c];
        return desc ? `${categoryLabel(c)}: ${desc}` : categoryLabel(c);
      }).join("\n")
    : categories.map(categoryLabel).join(", ");
  const request = userPrompt.length <= MAX_CLASSIFIER_PROMPT_CHARS
    ? userPrompt
    : `${userPrompt.slice(0, 4_000)}\n...[middle omitted]...\n${userPrompt.slice(-4_000)}`;
  const output = requireConfidence
    ? "<category> <confidence 0.0-1.0>"
    : "<category>";

  return (
    `Categories:\n${categoryList}\n\n` +
    `Choose exactly one category. Output ${output}. No explanation.\n\n` +
    `Request: ${request}\n\n` +
    `Category:`
  );
}

export function extractCategory(text: string, categories: readonly string[]): string | undefined {
  // Strip punctuation and whitespace — LLM may output "frontier." or "frontier\n".
  const needle = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+$/gu, "").replace(/^[^\p{L}\p{N}]+/gu, "");
  return categories.find((cat) => cat.toLowerCase() === needle);
}

function piCommand(): { command: string; args: string[] } {
  // Reuse the current Node binary and script path for subprocess.
  // Falls back to bare "pi" if argv[1] is unavailable (e.g. bundled executable).
  const script = process.argv[1];
  if (script) return { command: process.execPath, args: [script] };
  return { command: "pi", args: [] };
}

export function parseAttempt(
  content: string,
  categories: readonly string[],
  confidenceThreshold: number,
): ClassifierAttempt {
  const parsed = parseClassification(content, categories);
  if (!parsed.tier) return { status: "rejected" };
  if (confidenceThreshold > 0 &&
      (parsed.confidence === undefined || parsed.confidence < confidenceThreshold)) {
    return { status: "rejected" };
  }
  return { status: "accepted", tier: parsed.tier };
}

interface DirectClassification {
  outcome: ClassifierAttempt;
  /** True once a provider/endpoint accepted a direct attempt. */
  attempted: boolean;
}

async function classifyWithDirectHttp(
  ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
): Promise<DirectClassification> {
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options.temperature ?? 0;
  const threshold = options.confidenceThreshold ?? 0;
  const userPrompt = classificationPrompt(categories, prompt, options.tierDescriptions, threshold > 0);

  if (classifierModel.kind === "registry") {
    try {
      const provider = ctx.modelRegistry.getProvider(classifierModel.model.provider);
      if (!provider) return { attempted: false, outcome: { status: "failed" } };
      const auth = await ctx.modelRegistry.getProviderAuth(classifierModel.model.provider);
      if (!auth) return { attempted: false, outcome: { status: "failed" } };

      const stream = provider.streamSimple(
        classifierModel.model,
        {
          systemPrompt,
          messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
        },
        {
          maxTokens,
          temperature,
          signal: options.signal ?? ctx.signal,
          cacheRetention: "none",
          apiKey: auth.auth.apiKey,
          headers: auth.auth.headers,
          env: auth.env,
        },
      );
      try {
        const response = await stream.result();
        const content = response.content
          .filter((c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n")
          .trim();

        if (!content) {
          debug("classifier", "registry.empty_response", { model: classifierId(classifierModel) });
          return { attempted: true, outcome: { status: "failed" } };
        }

        const parsed = parseClassification(content, categories);
        const outcome = parseAttempt(content, categories, threshold);
        debug("classifier", "registry.done", {
          model: classifierId(classifierModel),
          raw: content.slice(0, 100),
          tier: parsed.tier,
          confidence: parsed.confidence,
          threshold,
          status: outcome.status,
        });
        return { attempted: true, outcome };
      } catch {
        return { attempted: true, outcome: { status: "failed" } };
      }
    } catch {
      return { attempted: false, outcome: { status: "failed" } };
    }
  }

  if (!isOpenAiCompatibleEndpoint(classifierModel)) {
    return { attempted: false, outcome: { status: "failed" } };
  }

  const body = {
    model: classifierId(classifierModel),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: temperature,
    stream: false,
  };

  const base = classifierBaseUrl(classifierModel);
  const baseUrl = base.endsWith("/") ? base : `${base}/`;
  const url = new URL("chat/completions", baseUrl).toString();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal ?? ctx.signal ?? AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      console.error(
        `[bifrost] classifier HTTP ${response.status} from ${classifierBaseUrl(classifierModel)}`,
      );
      return { attempted: true, outcome: { status: "failed" } };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      debug("classifier", "http.empty_response", { url: classifierBaseUrl(classifierModel) });
      return { attempted: true, outcome: { status: "failed" } };
    }

    const parsed = parseClassification(content, categories);
    const outcome = parseAttempt(content, categories, threshold);
    debug("classifier", "http.done", {
      model: classifierId(classifierModel),
      raw: content.slice(0, 100),
      tier: parsed.tier,
      confidence: parsed.confidence,
      threshold,
      status: outcome.status,
    });
    return { attempted: true, outcome };
  } catch {
    return { attempted: true, outcome: { status: "failed" } };
  }
}

async function classifyWithSubprocess(
  _ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
): Promise<ClassifierAttempt> {
  // Subprocess only works with registry models (needs provider/id for --model).
  if (classifierModel.kind !== "registry") return { status: "failed" };
  const model = classifierModel.model;
  debug("classifier", "subprocess.start", { model: `${model.provider}/${model.id}` });

  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const threshold = options.confidenceThreshold ?? 0;
  const userPrompt = classificationPrompt(categories, prompt, options.tierDescriptions, threshold > 0);
  const { command, args } = piCommand();

  const piArgs = [
    ...args,
    "--no-extensions",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--no-session",
    "--print",
    "--system-prompt",
    systemPrompt,
    "-p",
    userPrompt,
    "--model",
    `${model.provider}/${model.id}`,
  ];

  return new Promise((resolve) => {
    const child = spawn(command, piArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        TMPDIR: process.env.TMPDIR,
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ClassifierAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish({ status: "failed" });
    };
    const timer = setTimeout(() => {
      console.error(`[bifrost] classifier subprocess timed out`);
      abort();
    }, 30_000);

    const MAX_CHUNK = 2000;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_CHUNK) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_CHUNK) stderr += chunk;
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    child.on("error", (err: Error) => {
      console.error(`[bifrost] classifier subprocess error: ${err}`);
      finish({ status: "failed" });
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      if (code !== 0) {
        const modelId = `${model.provider}/${model.id}`;
        const diagnostic = parseClassifierStderr(stderr, modelId, code);
        debug("classifier", "subprocess.error", {
          model: modelId,
          exitCode: code,
          diagnosticCode: diagnostic.code,
          stderr: stderr.slice(0, 200),
        });
        console.error(`[bifrost] ${formatDiagnostic(diagnostic)}`);
        finish({ status: "failed" });
        return;
      }
      const parsed = parseClassification(stdout, categories);
      const outcome = parseAttempt(stdout, categories, threshold);
      debug("classifier", "subprocess.done", {
        model: `${model.provider}/${model.id}`,
        raw: stdout.trim().slice(0, 100),
        tier: parsed.tier,
        confidence: parsed.confidence,
        threshold,
        status: outcome.status,
      });
      finish(outcome);
    });
  });
}

export async function classifyWithLLM(
  ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
): Promise<ClassifierAttempt> {
  const method = options.method ?? "auto";

  if (method === "direct" || method === "auto") {
    const direct = await classifyWithDirectHttp(
      ctx,
      classifierModel,
      categories,
      prompt,
      options,
    );
    // A completed direct request must not be repeated through a subprocess.
    if (direct.attempted) return direct.outcome;
  }

  if (method === "subprocess" || method === "auto") {
    return classifyWithSubprocess(ctx, classifierModel, categories, prompt, options);
  }

  return { status: "failed" };
}
