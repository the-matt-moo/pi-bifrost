import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi-subagents announces child identities before session_start; forks are not children.
const children = new Set<string>();
export const CHILD_ROUTE_ENTRY = "bifrost-child-route";

export function noteChildSession(data: unknown, disposed = false): void {
  const id = (data as { sessionId?: unknown } | null)?.sessionId;
  if (typeof id !== "string") return;
  if (disposed) children.delete(id);
  else children.add(id);
}

export function isChildSession(ctx: ExtensionContext): boolean {
  const manager = ctx.sessionManager;
  const id = manager?.getSessionId?.();
  if (id && children.has(id)) return true;
  // Persisted identity also works when a child is resumed after a process restart.
  if (manager?.getEntries?.().some((entry) => entry.type === "custom" && entry.customType === CHILD_ROUTE_ENTRY)) return true;
  // Compatibility for older spawners that do not publish lifecycle events.
  if (process.env.PI_SUBAGENT_RUN_ID) return true;
  return /[\\/]tasks[\\/]/.test(manager?.getSessionFile?.() ?? "");
}
