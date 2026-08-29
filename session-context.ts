import { normalize } from "./cache.ts";
import { debug } from "./debug.ts";

export interface SessionContextConfig {
  maxHistory?: number;
  decayAfterMisses?: number;
  topicChangeThreshold?: number;
  idleTimeoutMs?: number;
}

interface HistoryEntry {
  tier: string;
  normalizedPrompt: string;
  timestamp: number;
}

const CONTINUATION_WORDS = new Set([
  "again", "continue", "more", "next", "okay", "please", "proceed", "same", "thanks", "that", "this", "yes",
]);

export class SessionRoutingContext {
  private history: HistoryEntry[] = [];
  private readonly maxHistory: number;
  private readonly decayAfterMisses: number;
  private readonly topicChangeThreshold: number;
  private readonly idleTimeoutMs: number;

  constructor(config: SessionContextConfig = {}) {
    this.maxHistory = config.maxHistory ?? 5;
    this.decayAfterMisses = config.decayAfterMisses ?? 3;
    this.topicChangeThreshold = config.topicChangeThreshold ?? 0.3;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 10 * 60 * 1000;
  }

  record(tier: string, prompt: string): void {
    this.history.push({
      tier,
      normalizedPrompt: normalize(prompt),
      timestamp: Date.now(),
    });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  suggest(prompt: string): string | undefined {
    this.pruneStale();
    if (this.history.length === 0) return undefined;

    if (this.isTopicChange(prompt)) {
      debug("session", "topic_change", { prompt: prompt.slice(0, 50) });
      return undefined;
    }

    const recent = this.history.slice(-this.decayAfterMisses);
    const tierCounts = new Map<string, number>();
    for (const entry of recent) {
      tierCounts.set(entry.tier, (tierCounts.get(entry.tier) ?? 0) + 1);
    }

    let dominant: string | undefined;
    let maxCount = 0;
    for (const [tier, count] of tierCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominant = tier;
      }
    }

    if (dominant && maxCount >= 2) {
      debug("session", "momentum", { tier: dominant, count: maxCount });
      return dominant;
    }

    return undefined;
  }

  isClearlyUnrelated(prompt: string): boolean {
    this.pruneStale();
    const normalized = normalize(prompt).split(" ").filter(Boolean);
    if (normalized.every((token) => CONTINUATION_WORDS.has(token))) return false;
    const current = [...new Set(normalized.filter(
      (token) => token.length >= 3 && !CONTINUATION_WORDS.has(token),
    ))];
    if (current.length < 2 || this.history.length === 0) return false;

    return this.history.every((entry) => {
      const previous = new Set(entry.normalizedPrompt.split(" ").filter(
        (token) => token.length >= 3 && !CONTINUATION_WORDS.has(token),
      ));
      return current.every((token) => !previous.has(token));
    });
  }

  reset(): void {
    this.history = [];
    debug("session", "reset");
  }

  private pruneStale(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    this.history = this.history.filter((e) => e.timestamp > cutoff);
  }

  private isTopicChange(prompt: string): boolean {
    if (this.history.length === 0) return false;
    const current = new Set(normalize(prompt).split(" ").filter(Boolean));
    if (current.size === 0) return false;

    const last = this.history[this.history.length - 1];
    const previous = new Set(last.normalizedPrompt.split(" ").filter(Boolean));
    if (previous.size === 0) return false;

    let intersection = 0;
    for (const token of current) {
      if (previous.has(token)) intersection++;
    }
    const union = current.size + previous.size - intersection;
    const similarity = union === 0 ? 0 : intersection / union;

    return similarity < this.topicChangeThreshold;
  }
}
