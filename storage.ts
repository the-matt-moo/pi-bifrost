import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function readJsonFile<T>(path: string): T | undefined {
  const text = readTextFile(path);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}