export interface ContextUsage {
  tokens: number | null;
  percent?: number | null;
}

export interface ContextSwitchTarget {
  contextWindow: number;
}

export interface ContextSwitchHost {
  getContextUsage?: () => ContextUsage | undefined;
  compact?: (options: {
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }) => void;
}

export interface ContextSwitchOptions {
  enabled: boolean;
  thresholdPercent: number;
  targetLabel: string;
  notify: (message: string, level: "info" | "warning" | "error") => void;
}

export function projectedContextPercent(tokens: number, targetContextWindow: number): number {
  return targetContextWindow > 0 ? (tokens / targetContextWindow) * 100 : Infinity;
}

export async function prepareContextSwitch(
  ctx: ContextSwitchHost,
  target: ContextSwitchTarget,
  options: ContextSwitchOptions,
): Promise<boolean> {
  if (!options.enabled) return true;

  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens == null) return true;

  const projected = projectedContextPercent(usage.tokens, target.contextWindow);
  if (projected < options.thresholdPercent) return true;

  if (!ctx.compact) {
    options.notify(
      `Bifrost: switch to ${options.targetLabel} skipped to preserve context; compaction is unavailable.`,
      "warning",
    );
    return false;
  }

  options.notify(
    `Bifrost: preserving context — compacting before switch to ${options.targetLabel} (${Math.round(projected)}% of target window).`,
    "warning",
  );

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      options.notify(
        `Bifrost: switch to ${options.targetLabel} skipped; context compaction timed out.`,
        "warning",
      );
      finish(false);
    }, 120_000);
    timer.unref?.();

    try {
      ctx.compact?.({
        customInstructions: "Preserve the active task, decisions, file changes, errors, and next steps.",
        onComplete: () => {
          options.notify(`Bifrost: context compacted; switching to ${options.targetLabel}.`, "info");
          finish(true);
        },
        onError: (error) => {
          options.notify(
            `Bifrost: switch to ${options.targetLabel} skipped; context compaction failed: ${error.message}`,
            "error",
          );
          finish(false);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.notify(
        `Bifrost: switch to ${options.targetLabel} skipped; context compaction failed: ${message}`,
        "error",
      );
      finish(false);
    }
  });
}
