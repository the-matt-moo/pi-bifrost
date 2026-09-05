import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Resolve a storage path. Global runtime artifacts (state/cache/reliability)
 * live under the agent dir (~/.pi/agent) so behavior is identical regardless
 * of cwd. An explicitly configured absolute path is returned as-is; "~"
 * expands to HOME; any other configured (or default) relative path resolves
 * against the agent dir.
 */
export function resolveStoragePath(
  _cwd: string,
  configuredPath: string | undefined,
  defaultRelativePath: string,
): string {
  if (configuredPath) {
    if (isAbsolute(configuredPath)) return configuredPath;
    if (configuredPath.startsWith("~")) {
      return (process.env.HOME ?? "/tmp") + configuredPath.slice(1);
    }
    return join(getAgentDir(), configuredPath);
  }
  return join(getAgentDir(), defaultRelativePath);
}

export function readTextFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf-8");
}

export function writeTextFile(path: string, text: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, text, "utf-8");
}

export function writeTextFileAtomic(path: string, text: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, text, "utf-8");
  try {
    renameSync(tempPath, path);
  } catch {
    try { unlinkSync(path); } catch { /* ignore */ }
    renameSync(tempPath, path);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock<T>(path: string, fn: () => T, staleMs = 30_000): T {
  const lockPath = `${path}.lock`;
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  for (;;) {
    try {
      const handle = openSync(lockPath, "wx");
      try {
        return fn();
      } finally {
        closeSync(handle);
        try { unlinkSync(lockPath); } catch { /* ignore */ }
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") throw err;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          try { unlinkSync(lockPath); } catch { /* ignore */ }
          continue;
        }
      } catch {
        try { unlinkSync(lockPath); } catch { /* ignore */ }
        continue;
      }
      sleepSync(25);
    }
  }
}

export function readJsonFile<T>(path: string): T | undefined {
  const text = readTextFile(path);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}

export function writeJsonFileAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  try {
    renameSync(tempPath, path);
  } catch {
    try { unlinkSync(path); } catch { /* ignore */ }
    renameSync(tempPath, path);
  }
}
