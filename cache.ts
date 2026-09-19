import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheEntry {
  normalized: string;
  category: string;
  lastUsed: number;
  hits: number;
}

export interface CacheOptions {
  enabled?: boolean;
  path?: string;
  threshold?: number;
  maxEntries?: number;
}

export const DEFAULT_MAX_ENTRIES = 500;
export const DEFAULT_THRESHOLD = 0.85;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort()
    .join(" ");
}

function jaccard(a: string, b: string): number {
  const setA = new Set(a.split(" "));
  const setB = new Set(b.split(" "));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

export function lookupCache(
  entries: CacheEntry[],
  text: string,
  threshold: number
): CacheEntry | undefined {
  const normalized = normalize(text);
  for (const entry of entries) {
    const score = jaccard(entry.normalized, normalized);
    if (score >= threshold) {
      return entry;
    }
  }
  return undefined;
}

export function touchCacheEntry(entry: CacheEntry): void {
  entry.lastUsed = Date.now();
  entry.hits += 1;
}

export function updateCache(
  entries: CacheEntry[],
  text: string,
  category: string,
  maxEntries: number
): CacheEntry[] {
  const normalized = normalize(text);
  const existingIndex = entries.findIndex((e) => e.normalized === normalized);
  const now = Date.now();

  if (existingIndex >= 0) {
    const updated = [...entries];
    updated[existingIndex] = {
      ...updated[existingIndex],
      category,
      lastUsed: now,
      hits: updated[existingIndex].hits + 1,
    };
    return updated;
  }

  const newEntry: CacheEntry = {
    normalized,
    category,
    lastUsed: now,
    hits: 0,
  };

  const updated = [newEntry, ...entries];
  if (updated.length > maxEntries) {
    updated.sort((a, b) => a.lastUsed - b.lastUsed);
    return updated.slice(0, maxEntries);
  }
  return updated;
}

export function cachePath(_cwd: string, customPath?: string): string {
  const agentDir = getAgentDir();
  if (customPath) {
    if (customPath.startsWith("~")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      return join(home, customPath.slice(1));
    }
    if (customPath.startsWith("/") || /^[A-Za-z]:/.test(customPath)) {
      return customPath;
    }
    return join(agentDir, customPath);
  }
  return join(agentDir, "bifrost-cache.jsonl");
}

export function loadCache(path: string): CacheEntry[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((e): e is CacheEntry => e !== null);
}

export function saveCache(path: string, entries: CacheEntry[]): void {
  const dir = join(path, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(path, content, "utf8");
}

export function createDeferredCacheWriter(
  path: string,
  getEntries: () => CacheEntry[]
): { schedule: () => void; flush: () => Promise<void>; flushSync: () => void } {
  let scheduled = false;
  let flushPromise: Promise<void> | null = null;

  const doFlush = async () => {
    scheduled = false;
    const entries = getEntries();
    try {
      saveCache(path, entries);
    } catch (err) {
      console.error("[bifrost] cache write failed:", err);
    }
  };

  return {
    schedule() {
      if (!scheduled) {
        scheduled = true;
        flushPromise = doFlush();
      }
    },
    async flush() {
      if (flushPromise) {
        await flushPromise;
      }
    },
    flushSync() {
      if (scheduled) {
        scheduled = false;
        const entries = getEntries();
        saveCache(path, entries);
      }
    },
  };
}

export function demoteCacheEntry(
  entries: CacheEntry[],
  prompt: string,
  tiers: string[]
): boolean {
  const normalized = normalize(prompt);
  const index = entries.findIndex((e) => e.normalized === normalized);
  if (index < 0) return false;
  const entry = entries[index];
  const currentTierIndex = tiers.indexOf(entry.category);
  if (currentTierIndex < 0 || currentTierIndex >= tiers.length - 1) return false;
  entry.category = tiers[currentTierIndex + 1];
  entry.lastUsed = Date.now();
  return true;
}

import type { RouteRule } from "./routing.ts";

export function warmStartCache(
  entries: CacheEntry[],
  rules: RouteRule[],
  tiers: string[],
  maxEntries: number
): CacheEntry[] {
  const newEntries = [...entries];
  for (const rule of rules) {
    if (tiers.includes(rule.model) && newEntries.length < maxEntries) {
      const normalized = normalize(rule.pattern);
      if (!newEntries.some((e) => e.normalized === normalized)) {
        newEntries.push({
          normalized,
          category: rule.model,
          lastUsed: Date.now(),
          hits: 0,
        });
      }
    }
  }
  return newEntries;
}