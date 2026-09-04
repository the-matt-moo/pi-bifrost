import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const REGISTRY_REFRESH_TTL_MS = 30_000;

export interface RegistryRefreshState {
  lastRegistryRefreshAt?: number;
  forceRegistryRefresh?: boolean;
  registryRefreshInflight?: Promise<boolean>;
}

export interface BifrostModeState {
  enabled: boolean;
  pinned: boolean;
  classifierEnabled: boolean;
  silent: boolean;
  thinkingMode?: "off" | "advisory" | "apply";
  thinkingPinned?: boolean;
  modelCategory?: string;
}

export function shouldRefreshRegistry(
  state: RegistryRefreshState,
  now = Date.now(),
  ttlMs = REGISTRY_REFRESH_TTL_MS,
): boolean {
  if (state.forceRegistryRefresh) return true;
  if (state.lastRegistryRefreshAt === undefined) return true;
  return now - state.lastRegistryRefreshAt >= ttlMs;
}

/** Deduplicates registry refreshes; callers choose whether to await the shared work. */
export function refreshRegistry(
  state: RegistryRefreshState,
  refresh: () => Promise<unknown>,
  onSuccess?: () => void,
  now = Date.now,
): Promise<boolean> {
  if (state.registryRefreshInflight) return state.registryRefreshInflight;
  const inflight = refresh()
    .then(() => {
      state.lastRegistryRefreshAt = now();
      state.forceRegistryRefresh = false;
      onSuccess?.();
      return true;
    })
    .catch(() => false)
    .finally(() => {
      if (state.registryRefreshInflight === inflight) state.registryRefreshInflight = undefined;
    });
  state.registryRefreshInflight = inflight;
  return inflight;
}

function statusText(ctx: ExtensionContext, tone: "dim" | "accent" | "success" | "warning" | "error", message: string): string {
  const bullet = tone === "success"
    ? ctx.ui.theme.fg("success", "●")
    : tone === "warning"
      ? ctx.ui.theme.fg("warning", "●")
      : tone === "error"
        ? ctx.ui.theme.fg("error", "●")
        : tone === "accent"
          ? ctx.ui.theme.fg("accent", "●")
          : ctx.ui.theme.fg("dim", "●");

  const textColor = tone === "success"
    ? "success"
    : tone === "warning"
      ? "warning"
      : tone === "error"
        ? "error"
        : tone === "accent"
          ? "accent"
          : "dim";

  return `${bullet}${ctx.ui.theme.fg("dim", " Bifrost · ")}${ctx.ui.theme.fg(textColor, message)}`;
}

export function setBifrostStatus(
  ctx: ExtensionContext,
  message?: string,
  tone: "dim" | "accent" | "success" | "warning" | "error" = "dim",
): void {
  if (!ctx.hasUI) return;
  if (!message) {
    ctx.ui.setStatus("bifrost-state", undefined);
    return;
  }

  const text = statusText(ctx, tone, message);
  ctx.ui.setStatus("bifrost-state", text);
}

export function setBifrostWorkingMessage(ctx: ExtensionContext, message?: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWorkingMessage(message);
}

function modeLabel(state: BifrostModeState): { tone: "warning" | "success"; text: string } {
  let text = "on";
  let tone: "warning" | "success" = "success";

  if (!state.enabled) {
    return { tone: "warning", text: "off" };
  }
  if (state.pinned) {
    text = "pinned";
    tone = "warning";
  } else if (!state.classifierEnabled) {
    text = "on · classifier off";
    tone = "warning";
  }

  if (state.thinkingPinned) {
    text += ` · think:pinned`;
    tone = "warning";
  } else if (state.thinkingMode && state.thinkingMode !== "off") {
    text += ` · think:${state.thinkingMode}`;
  }

  return { tone, text };
}

export function formatBifrostStatus(state: { enabled: boolean; pinned: boolean; silent: boolean; thinkingMode?: string; thinkingPinned?: boolean }): string[] {
  const name = state.enabled
    ? "\x1b[31mb\x1b[38;5;208mi\x1b[33mf\x1b[32mr\x1b[34mo\x1b[38;5;93ms\x1b[35mt\x1b[0m"
    : "\x1b[90mbifrost\x1b[0m";
  const bifrostLine = `${name}`;

  const pinColor = state.enabled
    ? (state.pinned ? "\x1b[38;5;208m" : "\x1b[32m")
    : "\x1b[90m";
  const pinLabel = `${pinColor}${state.pinned ? "pinned" : "unpinned"}\x1b[0m`;
  const modelLine = `  \x1b[90mmodel:\x1b[0m${pinLabel}`;

  const thinkColor = state.enabled
    ? (state.thinkingPinned ? "\x1b[38;5;208m" : (state.thinkingMode && state.thinkingMode !== "off" ? "\x1b[35m" : "\x1b[90m"))
    : "\x1b[90m";
  const thinkLabel = `${thinkColor}${state.thinkingPinned ? "pinned" : (state.thinkingMode && state.thinkingMode !== "off" ? state.thinkingMode : "apply")}\x1b[0m`;
  const thinkLine = `  \x1b[90mthink:\x1b[0m${thinkLabel}`;

  return [bifrostLine, modelLine, thinkLine];
}

export function setBifrostModeStatus(ctx: ExtensionContext, state: BifrostModeState): void {
  if (!ctx.hasUI) return;

  if (ctx.cwd) {
    try {
      const file = join(homedir(), ".pi", "agent", "statusline.json");
      let current: any = {};
      if (existsSync(file)) {
        try {
          current = JSON.parse(readFileSync(file, "utf-8"));
        } catch {}
      }
      current.bifrost = {
        enabled: state.enabled,
        pinned: state.pinned,
        silent: state.silent,
        thinkingMode: state.thinkingMode,
        thinkingPinned: state.thinkingPinned ?? false,
        ...(state.modelCategory ? { modelCategory: state.modelCategory } : {}),
      };
      writeFileSync(file, JSON.stringify(current, null, 2), "utf-8");
    } catch {}
  }

  const label = modeLabel(state);
  const text = statusText(ctx, label.tone, label.text);
  ctx.ui.setStatus("bifrost-state", text);
  const bifrostLines = formatBifrostStatus(state);
  ctx.ui.setStatus("bifrost", bifrostLines[0]);
  ctx.ui.setStatus("bifrost-model", bifrostLines[1]);
  ctx.ui.setStatus("bifrost-think", bifrostLines[2]);
}
