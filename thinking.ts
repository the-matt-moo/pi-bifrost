export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ThinkingSignals {
  text: string;
  turnDepth: number;
  lastTurnFailed: boolean;
  lastTurnErrored: boolean;
}

export interface ThinkingDecision {
  level: ThinkingLevel;
  score: number;
  reasons: string[];
  defaulted: boolean;
}

const SCAN_LIMIT = 4000;
const REASONING_PATTERN = /\b(regex|parser|algorithm|concurrency|race condition|deadlock|invariant|proof|complexity|optimi[sz]e|architecture|design|redesign|restructure|refactor|migration strategy|trade-?offs?)\b/i;
const DIAGNOSTIC_PATTERN = /\b(debug|root cause|why (?:is|does|doesn't|isn't)|stack ?trace|segfault|memory leak|flaky|reproduce|regression|security|vulnerabilit(?:y|ies)|audit|threat model)\b/i;
const MULTI_STEP_PATTERN = /\b(plan|step by step|compare|evaluate|alternatives|pros and cons|migrate|port)\b/i;
const MECHANICAL_PATTERN = /\b(typo|rename|reformat|format this|lint|add a comment|docstring|bump version|changelog entry|gitignore)\b/i;
const CORRECTION_PATTERN = /\b(no|nope|still|again|not quite|that(?:'s| is)? (?:not|wrong)|didn't work|doesn't work|same error|try again)\b/i;
const FILE_PATTERN = /\S+\.(?:ts|js|tsx|jsx|py|go|rs|java|rb|c|h|css|html|json|ya?ml|toml|sql|sh|md)\b/gi;
const HAS_FILE_PATTERN = /\S+\.(?:ts|js|tsx|jsx|py|go|rs|java|rb|c|h|css|html|json|ya?ml|toml|sql|sh|md)\b/i;

function countQuestionMarks(text: string): number {
  let count = 0;
  let index = -1;
  while ((index = text.indexOf("?", index + 1)) !== -1) count++;
  return count;
}

function fileReferenceCount(text: string): number {
  FILE_PATTERN.lastIndex = 0;
  let first: string | undefined;
  let second: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATTERN.exec(text)) !== null) {
    const file = match[0];
    if (first === undefined) first = file;
    else if (file !== first && second === undefined) second = file;
    else if (file !== first && file !== second) return 3;
  }
  return second === undefined ? (first === undefined ? 0 : 1) : 2;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\S+/g) ?? []);
}

/** Score a prompt using bounded lexical and structural signals. */
export function assessThinking(signals: ThinkingSignals): ThinkingDecision {
  const { text } = signals;
  const scanned = text.slice(0, SCAN_LIMIT);
  let score = 0;
  const reasons: string[] = [];

  if (REASONING_PATTERN.test(scanned)) {
    score += 3;
    reasons.push("+3 reasoning-intent");
  }
  if (DIAGNOSTIC_PATTERN.test(scanned)) {
    score += 2;
    reasons.push("+2 diagnostic");
  }
  if (MULTI_STEP_PATTERN.test(scanned)) {
    score += 1;
    reasons.push("+1 multi-step");
  }
  if (MECHANICAL_PATTERN.test(scanned)) {
    score -= 3;
    reasons.push("-3 mechanical");
  }
  if (signals.lastTurnFailed) {
    score += 2;
    reasons.push("+2 previous-turn-failed");
  }
  if (CORRECTION_PATTERN.test(scanned)) {
    score += 2;
    reasons.push("+2 correction");
  }
  if (signals.turnDepth >= 3) {
    score += 1;
    reasons.push("+1 task-depth");
  }
  if (signals.lastTurnErrored) {
    score += 1;
    reasons.push("+1 previous-turn-error");
  }
  if (text.length > 1500) {
    score += 1;
    reasons.push("+1 prompt-breadth");
  }
  if (text.length > 6000) {
    score += 1;
    reasons.push("+1 prompt-size");
  }
  if (HAS_FILE_PATTERN.test(scanned) && fileReferenceCount(scanned) >= 3) {
    score += 1;
    reasons.push("+1 multi-file");
  }
  if (scanned.includes("?") && countQuestionMarks(scanned) >= 2) {
    score += 1;
    reasons.push("+1 multiple-questions");
  }

  if (reasons.length === 0) {
    return { level: "medium", score: 0, reasons: [], defaulted: true };
  }

  const level: ThinkingLevel = score <= -2
    ? "minimal"
    : score <= 0
      ? "low"
      : score <= 2
        ? "medium"
        : score <= 5
          ? "high"
          : "xhigh";
  return { level, score, reasons, defaulted: false };
}

export const scoreThinking = assessThinking;

export function compareThinkingLevels(a: ThinkingLevel, b: ThinkingLevel): number {
  return LEVELS.indexOf(a) - LEVELS.indexOf(b);
}

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function clampToModel(
  level: ThinkingLevel,
  model: { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> },
  maximize = false,
): { level: ThinkingLevel; clamped: boolean; reason?: string } {
  if (maximize) level = "max";
  if (model.reasoning === false) {
    return level === "off"
      ? { level, clamped: false }
      : { level: "off", clamped: true, reason: "model does not support reasoning" };
  }

  const map = model.thinkingLevelMap;
  if (!map || level === "off") return { level, clamped: false };

  let index = LEVELS.indexOf(level);
  while (index > 0 && map[LEVELS[index]] === null) index--;
  const clampedLevel = LEVELS[index];
  return clampedLevel === level
    ? { level, clamped: false }
    : { level: clampedLevel, clamped: true, reason: `${level} unsupported by model` };
}

interface ThinkingHistoryEntry {
  level: ThinkingLevel;
  prompt: string;
  timestamp: number;
}

export interface ThinkingSessionConfig {
  maxHistory?: number;
  topicChangeThreshold?: number;
  idleTimeoutMs?: number;
}

export class ThinkingSession {
  private history: ThinkingHistoryEntry[] = [];
  private lastTurnFailed = false;
  private lastTurnErrored = false;
  private readonly maxHistory: number;
  private readonly topicChangeThreshold: number;
  private readonly idleTimeoutMs: number;

  constructor(config: ThinkingSessionConfig = {}) {
    this.maxHistory = config.maxHistory ?? 5;
    this.topicChangeThreshold = config.topicChangeThreshold ?? 0.3;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 10 * 60 * 1000;
  }

  record(level: ThinkingLevel, prompt: string): void {
    this.history.push({ level, prompt, timestamp: Date.now() });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  suggest(prompt: string, resetOnTopicChange = true): ThinkingLevel | undefined {
    this.pruneStale();
    if (this.history.length === 0) return undefined;
    if (this.isTopicChange(prompt)) {
      if (resetOnTopicChange) this.reset();
      return undefined;
    }
    return this.history[this.history.length - 1].level;
  }

  noteTurnOutcome(failed: boolean, errored: boolean): void {
    this.lastTurnFailed = failed;
    this.lastTurnErrored = errored;
  }

  getLastTurnOutcome(): { failed: boolean; errored: boolean } {
    return { failed: this.lastTurnFailed, errored: this.lastTurnErrored };
  }

  turnDepth(prompt: string): number {
    this.pruneStale();
    let depth = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.isTopicChange(prompt, this.history[i].prompt)) break;
      depth++;
      prompt = this.history[i].prompt;
    }
    return depth + 1;
  }

  reset(): void {
    this.history = [];
    this.lastTurnFailed = false;
    this.lastTurnErrored = false;
  }

  private pruneStale(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    this.history = this.history.filter((entry) => entry.timestamp > cutoff);
  }

  private isTopicChange(prompt: string, previous = this.history[this.history.length - 1]?.prompt): boolean {
    if (!previous) return false;
    const currentTokens = tokenize(prompt);
    const previousTokens = tokenize(previous);
    if (currentTokens.size === 0 || previousTokens.size === 0) return false;

    let intersection = 0;
    for (const token of currentTokens) if (previousTokens.has(token)) intersection++;
    const union = currentTokens.size + previousTokens.size - intersection;
    return (union === 0 ? 0 : intersection / union) < this.topicChangeThreshold;
  }
}
