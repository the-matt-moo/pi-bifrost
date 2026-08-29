import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCommandRouter, getBifrostCommandCompletions, type BifrostState } from "../commands.ts";

function makeCtx() {
  const calls: Array<{ kind: string; value?: unknown; title?: string; options?: string[]; lines?: string[] }> = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme: {
        fg: (_: string, text: string) => text,
      },
      select: async (title: string, options: string[]) => {
        calls.push({ kind: "select", title, options });
        return options.find((option) => option.includes("/bifrost off"));
      },
      notify: (message: string, type?: string) => {
        calls.push({ kind: "notify", value: `${type ?? "info"}:${message}` });
      },
      setStatus: (key: string, value: string | undefined) => {
        calls.push({ kind: "status", value: `${key}:${value ?? ""}` });
      },
      setWidget: (key: string, value: string[] | undefined) => {
        calls.push({ kind: "widget", value: `${key}:${value?.length ?? 0}`, lines: value });
      },
      setWorkingMessage: (_?: string) => {},
      setWorkingVisible: (_: boolean) => {},
      setEditorText: (value: string) => {
        calls.push({ kind: "editor", value });
      },
      setWorkingIndicator: () => {},
      confirm: async () => false,
      input: async () => undefined,
      onTerminalInput: () => () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined,
      pasteToEditor: () => {},
      getEditorText: () => "",
      editor: async () => undefined,
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      getTheme: () => undefined,
      getAllThemes: () => [],
      setTheme: () => ({ success: true }),
    },
  };
  return { ctx: ctx as never, calls };
}

function makeStore(reliabilityState?: Record<string, { failures: number[]; openUntil?: number }>, enabled = true) {
  const store = {
    getState: () => ({ version: 1 as const, models: reliabilityState ?? {} }),
    openCircuitCount: (now?: number) => {
      if (!enabled) return 0;
      const t = now ?? Date.now();
      return Object.entries(reliabilityState ?? {}).filter(([, r]) => r.openUntil && r.openUntil > t).length;
    },
  };
  return store;
}

function makeState(saveModeState: () => void = () => {}) {
  return {
    config: { models: {}, reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 } },
    enabled: true,
    classifierEnabled: true,
    thinkingMode: "off",
    thinkingPinned: false,
    thinkingLevel: "off",
    pinned: false,
    silent: false,
    cacheEntries: [],
    reliabilityStore: makeStore(),
    extensionDir: ".",
    getPipeline: () => ({ classify: async () => ({ kind: "unclassified" as const }) }),
    invalidatePipeline: () => {},
    saveModeState,
  };
}

describe("bifrost command ui", () => {
  it("surfaces command descriptions in autocomplete", () => {
    const items = getBifrostCommandCompletions("class") ?? [];
    assert(items.some((item) => item.value === "classifier status" && item.description === "Show classifier state"));
    assert(getBifrostCommandCompletions("sil")?.some((item) => item.value === "silence"));
  });

  it("opens dashboard for root command", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const dispatch = createCommandRouter(state as never);

    await dispatch("", ctx as never);

    const select = calls.find((call) => call.kind === "select");
    assert(select, "dashboard should open");
    assert.match(String(select?.title ?? ""), /Bifrost · on · model none/);
    assert.equal(select?.options?.length, 13);
    assert((select?.options ?? []).some((option) => option.includes("Disable routing")));
    assert.equal(state.enabled, false);
  });

  it("persists mode toggles", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState(() => calls.push({ kind: "save" }));
    const dispatch = createCommandRouter(state as never);

    await dispatch("off", ctx as never);
    await dispatch("pin", ctx as never);
    await dispatch("classifier off", ctx as never);

    assert.equal(calls.filter((call) => call.kind === "save").length, 3);
    assert.equal(state.enabled, false);
    assert.equal(state.pinned, true);
    assert.equal(state.classifierEnabled, false);
  });

  it("sets thinking mode and refreshes status", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState(() => calls.push({ kind: "save" }));
    const dispatch = createCommandRouter(state as never);

    await dispatch("thinking advisory", ctx as never);

    assert.equal(state.thinkingMode, "advisory");
    assert(calls.some((call) => call.kind === "save"));
    assert(calls.some((call) => call.kind === "status" && String(call.value).replace(/\x1b\[[0-9;]*m/g, "").includes("think:advisory")));
  });

  it("previews routing, thinking, and concise reasons", async () => {
    const { ctx } = makeCtx();
    const model = {
      provider: "test",
      id: "reasoner",
      cost: { input: 1, output: 2 },
      contextWindow: 128_000,
      reasoning: true,
    };
    Object.assign(ctx as object, {
      hasUI: false,
      mode: "rpc",
      modelRegistry: {
        find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
        getAvailable: () => [model],
      },
    });
    const state = makeState() as unknown as BifrostState;
    state.config = { models: { frontier: "test/reasoner" }, strategy: "first" };
    state.getPipeline = () => ({
      classify: async () => ({ kind: "classified" as const, tier: "frontier", source: "regex" as const }),
    });
    state.previewThinking = () => ({
      level: "high",
      mode: "advisory",
      summary: "score 3: reasoning intent",
    });
    const output: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => output.push(args.join(" "));
    try {
      await createCommandRouter(state)("preview design this parser", ctx as never);
    } finally {
      console.error = originalError;
    }

    const text = output.join("\n");
    assert.match(text, /thinking:  high \(advisory\)/);
    assert.match(text, /why model: regex chose frontier; first selected test\/reasoner/);
    assert.match(text, /why thinking: score 3: reasoning intent/);
  });

  it("silences and restores output", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState(() => calls.push({ kind: "save" }));
    const dispatch = createCommandRouter(state as never);

    await dispatch("silence", ctx as never);
    assert(calls.some((call) => call.kind === "status" && String(call.value).replace(/\x1b\[[0-9;]*m/g, "").includes("~ silence")));
    const notificationsBeforePin = calls.filter((call) => call.kind === "notify").length;
    await dispatch("pin", ctx as never);

    assert.equal(state.silent, true);
    assert.equal(calls.filter((call) => call.kind === "notify").length, notificationsBeforePin);

    await dispatch("unsilence", ctx as never);
    assert.equal(state.silent, false);
    assert(calls.some((call) => call.kind === "status" && String(call.value).replace(/\x1b\[[0-9;]*m/g, "").includes("~ unsilence")));
    assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("Bifrost output enabled")));
    assert.equal(calls.filter((call) => call.kind === "save").length, 3);
  });

  it("shows picker for unknown subcommand", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const dispatch = createCommandRouter(state as never);

    await dispatch("abc", ctx as never);

    const select = calls.find((call) => call.kind === "select");
    assert(select, "picker should open");
    assert.match(String(select?.title ?? ""), /Bifrost commands/);
    assert((select?.options ?? []).some((option) => option.includes("Disable routing")));
    assert.equal(state.enabled, false);
  });

  it("shows open circuit count in dashboard title", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const t = Date.now();
    state.reliabilityStore = makeStore({ "openai/gpt-5.4": { failures: [t], openUntil: t + 60_000 } });
    const dispatch = createCommandRouter(state as never);

    await dispatch("", ctx as never);

    const select = calls.find((call) => call.kind === "select");
    assert(select, "dashboard should open");
    assert.match(String(select?.title ?? ""), /circuits 1 open/);
  });

  it("prints open circuit count in debug output", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const t = Date.now();
    state.reliabilityStore = makeStore({ "openai/gpt-5.4": { failures: [t], openUntil: t + 60_000 } });
    const dispatch = createCommandRouter(state as never);

    await dispatch("debug", ctx as never);

    const widget = calls.find((call) => call.kind === "widget" && String(call.value).startsWith("bifrost-output:"));
    assert(widget?.lines?.some((line) => line.includes("openCircuits: 1")));
  });

  it("shows no open circuits when reliability is disabled", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.config.reliability.enabled = false;
    state.reliabilityStore = makeStore({ "openai/gpt-5.4": { failures: [Date.now()], openUntil: Date.now() + 60_000 } }, false);
    const dispatch = createCommandRouter(state as never);

    await dispatch("debug", ctx as never);

    const widget = calls.find((call) => call.kind === "widget" && String(call.value).startsWith("bifrost-output:"));
    assert(widget?.lines?.some((line) => line.includes("openCircuits: 0")));
  });
});
