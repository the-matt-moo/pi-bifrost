import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AuthResult } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// ── Quota telemetry for subscription-aware routing ─────────────────
//
// Self-contained fetch of weekly subscription quota for OpenAI/Codex
// and Google/Antigravity. Mirrors the endpoints used by the
// model-usage-status extension but keeps Bifrost independent of
// user-local extension files. Never stores credentials — only
// normalized fractions and reset times. All fetches are silent on
// failure; routing degrades to neutral weights when data is missing.

export interface ProviderQuota {
  /** Fraction of the weekly allowance remaining, 0..1. Undefined when unknown. */
  weeklyRemainingFraction?: number;
  /** Hours until the weekly window resets. Undefined when unknown. */
  hoursToReset?: number;
  /** Fraction of the rolling session (e.g. 5-hour) allowance remaining, 0..1.
   *  Drives hard 429-avoidance filtering. Undefined when unknown. */
  sessionRemainingFraction?: number;
}

export interface QuotaSnapshot {
  byProvider: Record<string, ProviderQuota>;
  fetchedAt: number;
}

export interface QuotaRoutingConfig {
  /** Fraction of weekly allowance treated as "exhausted" (default 0.03). */
  reservePercent?: number;
  /** Fraction of the rolling session allowance below which a model is treated
   *  as exhausted for every tier (default 0.05 — strictly over 95% used). */
  sessionReservePercent?: number;
  /** Exponent shaping quota bias — higher favors the heavier side harder (default 3). */
  gamma?: number;
  /** Snapshot older than this is treated as no data (minutes, default 15). */
  staleMinutes?: number;
  /** Refresh interval (minutes, default 15), capped by staleMinutes. */
  refreshMinutes?: number;
  /** Static per-provider overrides; pinned values always win. */
  providers?: Record<string, ProviderQuota>;
}

// ── Credentials ───────────────────────────────────────────────────

function getAuth(): Record<string, any> {
  try {
    const p = join(getAgentDir(), "auth.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

type ProviderAuthGetter = (provider: string) => Promise<AuthResult | undefined>;

function getCodexAccountId(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

async function getCodexAccess(
  getProviderAuth?: ProviderAuthGetter,
): Promise<{ token: string; accountId: string | null } | null> {
  const envToken = process.env.OPENAI_CODEX_TOKEN;
  if (envToken) return { token: envToken, accountId: getCodexAccountId(envToken) };
  if (!getProviderAuth) return null;

  try {
    const token = (await getProviderAuth("openai-codex"))?.auth.apiKey;
    return token ? { token, accountId: getCodexAccountId(token) } : null;
  } catch {
    return null;
  }
}

function getAntigravityToken(): string | null {
  if (process.env.ANTIGRAVITY_API_KEY) return process.env.ANTIGRAVITY_API_KEY;
  if (process.env.ANTIGRAVITY_TOKEN) return process.env.ANTIGRAVITY_TOKEN;
  const auth = getAuth();
  return auth.antigravity?.access || auth.antigravity?.token || null;
}

// ── Fetchers ───────────────────────────────────────────────────────

async function fetchCodexQuota(
  getProviderAuth?: ProviderAuthGetter,
): Promise<ProviderQuota | undefined> {
  const creds = await getCodexAccess(getProviderAuth);
  if (!creds?.token) return undefined;
  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      signal: AbortSignal.timeout(4000),
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "ChatGPT-Account-ID": creds.accountId || "",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as any;
    return parseCodexQuota(json);
  } catch {
    return undefined;
  }
}

/** Codex primary is normally the 5-hour session; identify explicit durations when supplied. */
export function parseCodexQuota(json: any): ProviderQuota | undefined {
  const result: ProviderQuota = {};
  for (const [name, window] of Object.entries(json?.rate_limit ?? {}) as [string, any][]) {
    if (!name.endsWith("_window") || typeof window?.used_percent !== "number" || !Number.isFinite(window.used_percent)) continue;
    const remaining = Math.max(0, Math.min(1, (100 - window.used_percent) / 100));
    const weekly = typeof window.limit_window_seconds === "number"
      ? window.limit_window_seconds >= 7 * 24 * 3600
      : name === "secondary_window";
    if (weekly) {
      result.weeklyRemainingFraction = remaining;
      result.hoursToReset = typeof window.reset_after_seconds === "number" ? window.reset_after_seconds / 3600 : undefined;
    } else {
      result.sessionRemainingFraction = remaining;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function parseAntigravityQuota(json: any, now = Date.now()): Record<string, ProviderQuota> | undefined {
  const quotas: Record<string, ProviderQuota> = {};
  let minWeekly: number | undefined;
  let minHours: number | undefined;

  for (const group of json?.groups ?? []) {
    const label = group.displayName || group.description || "";
    const family = /argon/i.test(label) ? "argon" : /claude|gpt|3p/i.test(label) ? "claude" : /gemini/i.test(label) ? "gemini" : undefined;
    if (!family) continue;
    const key = `antigravity:${family}`;
    const quota = quotas[key] ?? {};

    for (const bucket of group.buckets ?? []) {
      const remaining = bucket.remainingFraction;
      if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
      const window = (bucket.window || bucket.bucketId || bucket.displayName || "").toLowerCase();
      if (window.includes("week") || window.includes("7d")) {
        if (quota.weeklyRemainingFraction === undefined || remaining < quota.weeklyRemainingFraction) {
          quota.weeklyRemainingFraction = remaining;
          const resetMs = Date.parse(bucket.resetTime) - now;
          quota.hoursToReset = Number.isFinite(resetMs) ? Math.max(0, resetMs / 3_600_000) : undefined;
        }
        if (minWeekly === undefined || remaining < minWeekly) {
          minWeekly = remaining;
          minHours = quota.hoursToReset;
        }
      } else if (window.includes("5h") || window.includes("session")) {
        quota.sessionRemainingFraction = Math.min(quota.sessionRemainingFraction ?? 1, remaining);
      }
    }
    if (Object.keys(quota).length) quotas[key] = quota;
  }

  if (minWeekly !== undefined) quotas.antigravity = { weeklyRemainingFraction: minWeekly, hoursToReset: minHours };
  return Object.keys(quotas).length ? quotas : undefined;
}

async function fetchAntigravityQuota(): Promise<ProviderQuota | Record<string, ProviderQuota> | undefined> {
  const token = getAntigravityToken();
  if (!token) return undefined;
  const endpoints = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${ep}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        signal: AbortSignal.timeout(4000),
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "antigravity-client/0.2.6",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) continue;
      const quota = parseAntigravityQuota(await res.json());
      if (quota) return quota;
    } catch {}
  }
  return undefined;
}

// ── Store ──────────────────────────────────────────────────────────

function getAnthropicToken(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const auth = getAuth();
    return (
      auth.anthropic?.access ||
      auth.anthropic?.token ||
      auth.anthropic?.key ||
      auth.providers?.anthropic?.accessToken
    );
  } catch {
    return undefined;
  }
}

export function parseAnthropicQuota(json: any, now = Date.now()): ProviderQuota | undefined {
  const remaining = (window: any): number | undefined => {
    const utilization = window?.utilization;
    return typeof utilization === "number" && Number.isFinite(utilization) && utilization >= 0 && utilization <= 100
      ? 1 - utilization / 100
      : undefined;
  };
  const weekly = json?.seven_day;
  const session = json?.five_hour;
  const weeklyUsage = remaining(weekly) !== undefined ? weekly : remaining(session) !== undefined ? session : undefined;
  if (!weeklyUsage) return undefined;

  let hoursToReset: number | undefined;
  if (weeklyUsage.resets_at) {
    const resetMs = new Date(weeklyUsage.resets_at).getTime() - now;
    if (resetMs > 0) hoursToReset = resetMs / 3600_000;
  }

  const result: ProviderQuota = { weeklyRemainingFraction: remaining(weeklyUsage), hoursToReset };
  const sessionRemaining = remaining(session);
  if (sessionRemaining !== undefined) result.sessionRemainingFraction = sessionRemaining;
  return result;
}

async function fetchAnthropicQuota(): Promise<ProviderQuota | undefined> {
  const token = getAnthropicToken();
  if (!token) return undefined;
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      signal: AbortSignal.timeout(4000),
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    });
    if (!res.ok) return undefined;
    return parseAnthropicQuota(await res.json());
  } catch {
    return undefined;
  }
}

type QuotaFetcher = () => Promise<[
  ProviderQuota | undefined,
  ProviderQuota | Record<string, ProviderQuota> | undefined,
  ProviderQuota | undefined,
]>;

export class QuotaStore {
  private snapshot: QuotaSnapshot = { byProvider: {}, fetchedAt: 0 };
  private inflight: Promise<void> | undefined;
  private cfg: QuotaRoutingConfig | undefined;
  private fetchQuotas: QuotaFetcher;

  constructor(
    cfg: QuotaRoutingConfig | undefined,
    fetchQuotas?: QuotaFetcher,
    getProviderAuth?: ProviderAuthGetter,
  ) {
    this.cfg = cfg;
    this.fetchQuotas = fetchQuotas ?? (() => Promise.all([
      fetchCodexQuota(getProviderAuth),
      fetchAntigravityQuota(),
      fetchAnthropicQuota(),
    ]));
  }

  getSnapshot(): QuotaSnapshot {
    return this.snapshot;
  }

  get config(): QuotaRoutingConfig | undefined {
    return this.cfg;
  }

  /** True when the snapshot is fresh enough to drive weighting. */
  isFresh(now: number): boolean {
    const stale = this.cfg?.staleMinutes ?? 15;
    return now - this.snapshot.fetchedAt < stale * 60_000;
  }

  /** Refresh only when the snapshot is older than refreshMinutes or empty. Never throws. */
  async refreshIfStale(now: number, force = false): Promise<void> {
    const refresh = Math.min(this.cfg?.refreshMinutes ?? 15, this.cfg?.staleMinutes ?? 15);
    if (!force && this.snapshot.fetchedAt > 0 &&
        now - this.snapshot.fetchedAt < refresh * 60_000) {
      return;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.fetch(now);
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  private async fetch(now: number): Promise<void> {
    const [codex, ag, anthropic] = await this.fetchQuotas();
    const byProvider: Record<string, ProviderQuota> = {};
    if (codex) byProvider["openai-codex"] = codex;
    if (ag) {
      if ("weeklyRemainingFraction" in ag) {
        byProvider["antigravity"] = ag as ProviderQuota;
      } else {
        Object.assign(byProvider, ag);
      }
    }
    if (anthropic) byProvider["anthropic"] = anthropic;
    // Static config pins always win over live telemetry.
    for (const [provider, pinned] of Object.entries(this.cfg?.providers ?? {})) {
      byProvider[provider] = { ...pinned };
    }
    this.snapshot = { byProvider, fetchedAt: now };
  }

  /** Test seam. */
  setSnapshot(snapshot: QuotaSnapshot): void {
    this.snapshot = snapshot;
  }
}