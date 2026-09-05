import { resolveStoragePath, readJsonFile, writeJsonFileAtomic } from "./storage.ts";

/**
 * Runtime mode state that must survive extension reload and Pi restart.
 * Persisted separately from bifrost.json (config) so user runtime toggles
 * (`/bifrost on|off`, `/bifrost pin|unpin`, `/bifrost classifier on|off`,
 * `/bifrost silence|unsilence`) are not clobbered by config reloads.
 */
export interface RuntimeModeState {
  enabled: boolean;
  pinned: boolean;
  classifierEnabled: boolean;
  thinkingMode?: "off" | "advisory" | "apply";
  silent: boolean;
}

/**
 * Subset of runtime state that is persisted across extension reload and Pi
 * restart. `pinned` is deliberately excluded — it is session-local only and
 * must not be read from or written to disk.
 */
export interface PersistedModeState {
  enabled: boolean;
  classifierEnabled: boolean;
  thinkingMode?: "off" | "advisory" | "apply";
  silent: boolean;
}

export const DEFAULT_RUNTIME_STATE: RuntimeModeState = {
  enabled: true,
  pinned: false,
  classifierEnabled: true,
  silent: false,
};

export function runtimeStatePath(_cwd: string, sessionId?: string): string {
  if (sessionId) {
    return resolveStoragePath(_cwd, undefined, `bifrost-sessions/${sessionId}/bifrost-state.json`);
  }
  return resolveStoragePath(_cwd, undefined, "bifrost-state.json");
}

export function loadRuntimeState(path: string, fallback: RuntimeModeState = DEFAULT_RUNTIME_STATE): RuntimeModeState {
  try {
    const parsed = readJsonFile<Partial<RuntimeModeState>>(path);
    if (!parsed) return { ...fallback };
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : fallback.enabled,
      pinned: false,
      classifierEnabled:
        typeof parsed.classifierEnabled === "boolean"
          ? parsed.classifierEnabled
          : fallback.classifierEnabled,
      ...(parsed.thinkingMode === "advisory" || parsed.thinkingMode === "apply" || parsed.thinkingMode === "off"
        ? { thinkingMode: parsed.thinkingMode }
        : fallback.thinkingMode !== undefined ? { thinkingMode: fallback.thinkingMode } : {}),
      silent: typeof parsed.silent === "boolean" ? parsed.silent : fallback.silent,
    };
  } catch (err) {
    console.error(`[bifrost] failed to load runtime state: ${err}`);
    return { ...fallback };
  }
}

export function saveRuntimeState(path: string, state: PersistedModeState): void {
  try {
    writeJsonFileAtomic(path, state);
  } catch (err) {
    console.error(`[bifrost] failed to save runtime state: ${err}`);
  }
}
