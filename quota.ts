import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

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
   *  as exhausted for every tier except `quick` (default 0.10 — over 90% used). */
  sessionReservePercent?: number;
  /** Exponent shaping quota bias — higher favors the heavier side harder (default 3). */
  gamma?: number;
  /** Snapshot older than this is treated as no data (minutes, default 15). */
  staleMinutes?: number;
  /** Minimum interval between background refreshes (minutes, default 30). */
  refreshMinutes?: number;
  /** Static per-provider overrides; pinned values always win. */
  providers?: Record<string, ProviderQuota>;
}

// ── Credentials (mirrors model-usage-status.ts) ────────────────────

function getAuth(): Record<string, any> {
  try {
    const p = join(getAgentDir(), "auth.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

async function getCodexAccess(): Promise<{ token: string; accountId: string | null } | null> {
  if (process.env.OPENAI_CODEX_TOKEN) {
    return { token: process.env.OPENAI_CODEX_TOKEN, accountId: null };
  }
  const auth = getAuth();
  const codex = auth["openai-codex"];
  if (!codex?.access) return null;

  let token = codex.access;
  let accountId = codex.accountId ?? null;

  if (codex.expires && Date.now() >= codex.expires && codex.refresh) {
    try {
      const res = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: codex.refresh,
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        token = json.access_token;
        codex.access = json.access_token;
        if (json.refresh_token) codex.refresh = json.refresh_token;
        codex.expires = Date.now() + json.expires_in * 1000;
        try {
          writeFileSync(join(getAgentDir(), "auth.json"), JSON.stringify(auth, null, 2));
        } catch {}
      }
    } catch {}
  }

  return { token, accountId };
}

function getAntigravityToken(): string | null {
  if (process.env.ANTIGRAVITY_API_KEY) return process.env.ANTIGRAVITY_API_KEY;
  if (process.env.ANTIGRAVITY_TOKEN) return process.env.ANTIGRAVITY_TOKEN;
  const auth = getAuth();
  return auth.antigravity?.access || auth.antigravity?.token || null;
}

// ── Fetchers ───────────────────────────────────────────────────────

async function fetchCodexQuota(): Promise<ProviderQuota | undefined> {
  const creds = await getCodexAccess();
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
    const primary = json?.rate_limit?.primary_window;
    if (typeof primary?.used_percent !== "number") return undefined;
    const remaining = Math.max(0, (100 - primary.used_percent) / 100);
    const hours =
      typeof primary.reset_after_seconds === "number"
        ? primary.reset_after_seconds / 3600
        : undefined;
    return { weeklyRemainingFraction: remaining, hoursToReset: hours };
  } catch {
    return undefined;
  }
}

async function fetchAntigravityQuota(): Promise<ProviderQuota | undefined> {
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
      const json = (await res.json()) as any;
      const groups = json.groups || [];
      for (const g of groups) {
        for (const b of g.buckets || []) {
          const w = (b.window || b.bucketId || b.displayName || "").toLowerCase();
          if (!(w.includes("week") || w.includes("7d"))) continue;
          if (typeof b.remainingFraction !== "number") continue;
          const hours = b.resetTime
            ? Math.max(0, (Date.parse(b.resetTime) - Date.now()) / 3_600_000)
            : undefined;
          if (Number.isNaN(hours)) return { weeklyRemainingFraction: b.remainingFraction };
          return { weeklyRemainingFraction: b.remainingFraction, hoursToReset: hours };
        }
      }
    } catch {}
  }
  return undefined;
}

// ── Store ──────────────────────────────────────────────────────────

function getAnthropicToken(): string | undefined {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (!existsSync(authPath)) return undefined;
    const json = JSON.parse(readFileSync(authPath, "utf-8"));
    return json?.providers?.anthropic?.accessToken;
  } catch {
    return undefined;
  }
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
    const json = (await res.json()) as any;
    
    // Weekly balancing prefers the 7-day window; falls back to the session
    // (5-hour) window only when weekly telemetry is absent.
    const weekly = json?.seven_day;
    const session = json?.five_hour;
    const weeklyUsage = weekly?.utilization !== undefined ? weekly : session;
    if (!weeklyUsage || typeof weeklyUsage.utilization !== "number") return undefined;

    let hoursToReset: number | undefined;
    if (weeklyUsage.resets_at) {
      const resetMs = new Date(weeklyUsage.resets_at).getTime() - Date.now();
      if (resetMs > 0) hoursToReset = resetMs / 3600_000;
    }

    const result: ProviderQuota = {
      weeklyRemainingFraction: Math.max(0, 1 - weeklyUsage.utilization),
      hoursToReset,
    };
    // The session window drives the hard 429-avoidance filter. A session can be
    // fully drained while the weekly window still shows headroom.
    if (session && typeof session.utilization === "number") {
      result.sessionRemainingFraction = Math.max(0, 1 - session.utilization);
    }
    return result;
  } catch {
    return undefined;
  }
}

type QuotaFetcher = () => Promise<[
  ProviderQuota | undefined,
  ProviderQuota | undefined,
  ProviderQuota | undefined,
]>;

export class QuotaStore {
  private snapshot: QuotaSnapshot = { byProvider: {}, fetchedAt: 0 };
  private inflight: Promise<void> | undefined;
  private cfg: QuotaRoutingConfig | undefined;
  private fetchQuotas: QuotaFetcher;

  constructor(
    cfg: QuotaRoutingConfig | undefined,
    fetchQuotas: QuotaFetcher = () => Promise.all([
      fetchCodexQuota(),
      fetchAntigravityQuota(),
      fetchAnthropicQuota(),
    ]),
  ) {
    this.cfg = cfg;
    this.fetchQuotas = fetchQuotas;
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
  async refreshIfStale(now: number): Promise<void> {
    const refresh = this.cfg?.refreshMinutes ?? 30;
    if (this.snapshot.fetchedAt > 0 &&
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
    if (ag) byProvider["antigravity"] = ag;
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