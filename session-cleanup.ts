import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { debug } from "./debug.ts";

export interface SessionCleanupResult {
  scanned: number;
  removed: number;
  errors: string[];
}

export interface SessionCleanupOptions {
  maxAgeMs?: number;
  rootDir?: string;
  now?: number;
}

function sessionRoot(rootDir?: string): string {
  return rootDir ?? join(getAgentDir(), "bifrost-sessions");
}

/**
 * Remove stale Bifrost session-scoped state directories.
 *
 * Session runtime state is intentionally per-session, but old session files
 * should not accumulate forever. This removes directories whose state file is
 * older than the configured age.
 */
export function cleanupSessionState(options: SessionCleanupOptions = {}): SessionCleanupResult {
  const root = sessionRoot(options.rootDir);
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60_000;
  const now = options.now ?? Date.now();
  const result: SessionCleanupResult = { scanned: 0, removed: 0, errors: [] };

  if (!existsSync(root)) return result;

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      result.scanned++;
      const dir = join(root, entry.name);
      const statePath = join(dir, "bifrost-state.json");
      try {
        const mtime = existsSync(statePath) ? statSync(statePath).mtimeMs : statSync(dir).mtimeMs;
        if (now - mtime < maxAgeMs) continue;
        rmSync(dir, { recursive: true, force: true });
        result.removed++;
      } catch (err) {
        result.errors.push(`${entry.name}: ${String(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(String(err));
  }

  if (result.removed > 0 || result.errors.length > 0) {
    debug("cleanup", "session_state", {
      root,
      scanned: result.scanned,
      removed: result.removed,
      errors: result.errors.length,
    });
  }

  return result;
}

export function scheduleSessionCleanup(options: SessionCleanupOptions = {}): NodeJS.Timeout {
  const timer = setInterval(() => {
    cleanupSessionState(options);
  }, options.maxAgeMs ? Math.max(60_000, Math.min(options.maxAgeMs, 24 * 60 * 60_000)) : 24 * 60 * 60_000);
  timer.unref?.();
  return timer;
}
