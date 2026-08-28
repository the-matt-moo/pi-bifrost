import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveStoragePath, readTextFile, writeTextFile } from "./storage.ts";

export interface CacheEntry {
  normalized: string;
  category: string;
  lastUsed: number;
  hits: number;
  /** Monotonic sequence number for stable eviction ordering. */
  seq?: number;
  /** Times this entry was implicitly demoted (re-prompt or manual override). */
  demotions?: number;
  /** True if this entry was auto-seeded, not from real classification. */
  synthetic?: boolean;
}

export interface CacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  threshold?: number;
  path?: string;
}

export const DEFAULT_MAX_ENTRIES = 500;
export const DEFAULT_THRESHOLD = 0.85;

let nextSeq = 0;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

function normalizedTokenSet(text: string): Set<string> {
  return new Set(text.split(" ").filter(Boolean));
}

interface CacheLookupIndex {
  exact: Map<string, CacheEntry>;
  tokens: Map<CacheEntry, Set<string>>;
}

const lookupIndexes = new WeakMap<CacheEntry[], CacheLookupIndex>();

function lookupIndex(entries: CacheEntry[]): CacheLookupIndex {
  let index = lookupIndexes.get(entries);
  if (index) return index;
  const exact = new Map<string, CacheEntry>();
  for (const entry of entries) {
    if (!exact.has(entry.normalized)) exact.set(entry.normalized, entry);
  }
  index = {
    exact,
    tokens: new Map(entries.map((entry) => [entry, normalizedTokenSet(entry.normalized)])),
  };
  lookupIndexes.set(entries, index);
  return index;
}

export function loadCache(path: string): CacheEntry[] {
  try {
    const text = readTextFile(path);
    if (text === undefined) return [];
    const entries = text
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        try {
          return JSON.parse(line) as CacheEntry;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is CacheEntry => e !== undefined);

    // Seed seq counter from loaded entries to avoid collision on restart.
    const maxSeq = entries.reduce((max: number, e: CacheEntry) => Math.max(max, e.seq ?? 0), 0);
    if (maxSeq >= nextSeq) nextSeq = maxSeq + 1;

    return entries;
  } catch (err) {
    console.error(`[bifrost] failed to load cache: ${err}`);
    return [];
  }
}

function serializeCache(entries: CacheEntry[]): string {
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
  return lines ? lines + "\n" : "";
}

export function saveCache(path: string, entries: CacheEntry[]) {
  try {
    writeTextFile(path, serializeCache(entries));
  } catch (err) {
    console.error(`[bifrost] failed to save cache: ${err}`);
  }
}

async function saveCacheAsync(path: string, entries: CacheEntry[]): Promise<boolean> {
  const text = serializeCache(entries);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf-8");
    return true;
  } catch (err) {
    console.error(`[bifrost] failed to save cache: ${err}`);
    return false;
  }
}

export interface DeferredCacheWriter {
  schedule(): void;
  flush(): Promise<void>;
  flushSync(): void;
}

/** Coalesces cache mutations and keeps synchronous I/O off prompt routing. */
export function createDeferredCacheWriter(
  path: string,
  getEntries: () => CacheEntry[],
): DeferredCacheWriter {
  let scheduled: NodeJS.Immediate | undefined;
  let generation = 0;
  let queuedGeneration = 0;
  let persistedGeneration = 0;
  let writes = Promise.resolve();

  const enqueue = () => {
    if (queuedGeneration >= generation) return writes;
    const target = generation;
    const entries = [...getEntries()];
    queuedGeneration = target;
    writes = writes.then(async () => {
      if (await saveCacheAsync(path, entries)) {
        persistedGeneration = Math.max(persistedGeneration, target);
      }
    });
    return writes;
  };

  const schedule = () => {
    generation++;
    if (scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      void enqueue();
    });
    scheduled.unref?.();
  };

  return {
    schedule,
    async flush() {
      if (scheduled) {
        clearImmediate(scheduled);
        scheduled = undefined;
      }
      while (persistedGeneration < generation) {
        const target = generation;
        await enqueue();
        if (persistedGeneration < target) return;
      }
    },
    flushSync() {
      if (scheduled) {
        clearImmediate(scheduled);
        scheduled = undefined;
      }
      if (persistedGeneration >= generation) return;
      saveCache(path, getEntries());
      persistedGeneration = generation;
      queuedGeneration = generation;
    },
  };
}

function evictIfNeeded(entries: CacheEntry[], maxEntries: number): CacheEntry[] {
  if (entries.length <= maxEntries) return entries;
  // Sort by lastUsed descending; tie-break by seq (newer entries have higher seq).
  return [...entries]
    .sort((a, b) => b.lastUsed - a.lastUsed || (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, maxEntries);
}

/** Pure query — finds matching cache entry without mutation. */
export function lookupCache(
  entries: CacheEntry[],
  prompt: string,
  threshold: number,
): CacheEntry | undefined {
  const normalized = normalize(prompt);
  const index = lookupIndex(entries);
  const exact = index.exact.get(normalized);
  if (exact) return exact;

  const promptTokens = normalizedTokenSet(normalized);
  let best: { entry: CacheEntry; score: number } | undefined;

  for (const entry of entries) {
    const entryTokens = index.tokens.get(entry)!;
    if (promptTokens.size === 0 || entryTokens.size === 0) continue;

    let intersection = 0;
    for (const token of promptTokens) {
      if (entryTokens.has(token)) intersection++;
    }
    const union = promptTokens.size + entryTokens.size - intersection;
    const score = union === 0 ? 0 : intersection / union;
    if (score >= threshold && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  return best?.entry;
}

/** Explicit mutation — updates LRU timestamp and hit count. */
export function touchCacheEntry(entry: CacheEntry): void {
  entry.lastUsed = Date.now();
  entry.hits++;
}

const TIER_ESCALATION: Record<string, string> = {
  quick: "general",
  general: "frontier",
};

const DEMOTION_THRESHOLD = 3;

export function demoteCacheEntry(
  entries: CacheEntry[],
  prompt: string,
  tiers: readonly string[],
): boolean {
  const normalized = normalize(prompt);
  const entry = entries.find((e) => e.normalized === normalized);
  if (!entry) return false;

  entry.demotions = (entry.demotions ?? 0) + 1;
  if (entry.demotions >= DEMOTION_THRESHOLD) {
    const escalated = TIER_ESCALATION[entry.category];
    if (escalated && tiers.includes(escalated)) {
      entry.category = escalated;
      entry.demotions = 0;
      return true;
    }
  }
  return false;
}

export function updateCache(
  entries: CacheEntry[],
  prompt: string,
  category: string,
  maxEntries: number,
): CacheEntry[] {
  const normalized = normalize(prompt);
  const idx = entries.findIndex((e) => e.normalized === normalized);

  if (idx !== -1) {
    const updated = [...entries];
    updated[idx] = {
      ...updated[idx],
      category,
      lastUsed: Date.now(),
      hits: updated[idx].hits + 1,
    };
    return evictIfNeeded(updated, maxEntries);
  }

  return evictIfNeeded(
    [...entries, { normalized, category, lastUsed: Date.now(), hits: 1, seq: nextSeq++ }],
    maxEntries,
  );
}

export function cachePath(cwd: string, configuredPath?: string): string {
  return resolveStoragePath(cwd, configuredPath, ".pi/bifrost-cache.jsonl");
}

export function warmStartCache(
  entries: CacheEntry[],
  rules: Array<{ pattern: string; model: string }>,
  tiers: readonly string[],
  maxEntries: number,
): CacheEntry[] {
  if (entries.length > 0) return entries;

  const seeds: Array<{ text: string; tier: string }> = [];
  const phrasePattern = /[a-z][a-z ]{3,}/gi;

  for (const rule of rules) {
    if (!tiers.includes(rule.model)) continue;
    const matches = rule.pattern
      .replace(/\\b/g, "")
      .replace(/\(\?\:[^)]*\)/g, "")
      .replace(/[()^$|\\?+*\[\]{}]/g, " ")
      .replace(/\\s/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .match(phrasePattern);

    if (matches) {
      for (const phrase of matches.slice(0, 3)) {
        if (phrase.trim().length > 3) {
          seeds.push({ text: phrase.trim(), tier: rule.model });
        }
      }
    }
  }

  let result = entries;
  for (const seed of seeds) {
    result = updateCache(result, seed.text, seed.tier, maxEntries);
    const last = result[result.length - 1];
    if (last) last.synthetic = true;
  }

  return result;
}
