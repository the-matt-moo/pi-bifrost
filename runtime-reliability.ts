import type { ImageContent } from "@earendil-works/pi-ai";

interface AssistantOutcome {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: unknown;
}

function modelKey(message: AssistantOutcome): string | undefined {
  if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
  return `${message.provider}/${message.model}`;
}

/** Tracks one Bifrost-routed agent run across Pi's internal retries. */
export interface RuntimeRetryContext {
  prompt: string;
  images?: ImageContent[];
  tier: string;
  autoRetryCount: number;
}

export interface RuntimeFailure {
  model: string;
  reason?: string;
  replaySafe: boolean;
  retry?: RuntimeRetryContext;
}

export class RuntimeReliabilityTracker {
  private selectedModel: string | undefined;
  private pendingFailure: string | undefined;
  private retry: RuntimeRetryContext | undefined;
  private hadAssistantOutput = false;
  private hadToolResults = false;

  begin(selectedModel: string, retry?: RuntimeRetryContext): void {
    this.selectedModel = selectedModel;
    this.pendingFailure = undefined;
    this.retry = retry;
    this.hadAssistantOutput = false;
    this.hadToolResults = false;
  }

  observe(messages: readonly AssistantOutcome[]): void {
    if (!this.selectedModel) return;
    let last: AssistantOutcome | undefined;
    for (const message of messages) {
      if (message.role !== "assistant" || modelKey(message) !== this.selectedModel) continue;
      last = message;
      if (Array.isArray(message.content) ? message.content.length > 0 : message.content != null) {
        this.hadAssistantOutput = true;
      }
    }
    if (!last) return;
    this.pendingFailure = last.stopReason === "error"
      ? (typeof last.errorMessage === "string" ? last.errorMessage : "provider request failed")
      : undefined;
  }

  noteToolResults(toolResults: readonly unknown[]): void {
    if (this.selectedModel && toolResults.length > 0) this.hadToolResults = true;
  }

  /** Returns model on both success and failure. reason undefined = clean settle. */
  settle(): RuntimeFailure | undefined {
    const failure = this.pendingFailure;
    const model = this.selectedModel;
    const retry = this.retry;
    const replaySafe = !!failure && !this.hadAssistantOutput && !this.hadToolResults;
    this.selectedModel = undefined;
    this.pendingFailure = undefined;
    this.retry = undefined;
    this.hadAssistantOutput = false;
    this.hadToolResults = false;
    if (!model) return undefined;
    return { model, reason: failure, replaySafe, retry };
  }
}
