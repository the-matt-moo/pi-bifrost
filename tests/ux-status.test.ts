import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  setBifrostStatus,
  setBifrostWorkingMessage,
  setBifrostModeStatus,
  shouldRefreshRegistry,
  refreshRegistry,
  type RegistryRefreshState,
} from "../ux-status.ts";

function makeCtx() {
  const calls: Array<{ kind: string; key?: string; value?: unknown }> = [];
  return {
    calls,
    ctx: {
      hasUI: true,
      ui: {
        theme: {
          fg: (_: string, text: string) => text,
        },
        setStatus: (key?: string, value?: string) => {
          calls.push({ kind: "status", key, value });
        },
        setWorkingMessage: (value?: string) => {
          calls.push({ kind: "working", key: "working", value });
        },
      },
    },
  } as const;
}

describe("ux status helpers", () => {
  it("renders Bifrost status line", () => {
    const { ctx, calls } = makeCtx();
    setBifrostStatus(ctx as never, "classifying prompt…", "accent");
    assert.equal(calls[0]?.kind, "status");
    assert.equal(calls[0]?.key, "bifrost-state");
    assert.match(String(calls[0]?.value ?? ""), /Bifrost · classifying prompt/);
  });

  it("clears Bifrost status line", () => {
    const { ctx, calls } = makeCtx();
    setBifrostStatus(ctx as never, undefined);
    assert.equal(calls[0]?.kind, "status");
    assert.equal(calls[0]?.key, "bifrost-state");
    assert.equal(calls[0]?.value, undefined);
  });

  it("sets working message", () => {
    const { ctx, calls } = makeCtx();
    setBifrostWorkingMessage(ctx as never, "Bifrost classifying...");
    assert.equal(calls[0]?.kind, "working");
    assert.equal(calls[0]?.value, "Bifrost classifying...");
  });

  it("renders persistent mode state", () => {
    const { ctx, calls } = makeCtx();
    setBifrostModeStatus(ctx as never, { enabled: true, pinned: false, classifierEnabled: true, silent: false });
    assert.equal(calls[0]?.kind, "status");
    assert.equal(calls[0]?.key, "bifrost-state");
    assert.match(String(calls[0]?.value ?? ""), /Bifrost · on/);
    assert.equal(calls[1]?.key, "bifrost");
    assert.match(String(calls[1]?.value ?? "").replace(/\x1b\[[0-9;]*m/g, ""), /bifrost: unpinned ~ unsilence/);

    calls.length = 0;
    setBifrostModeStatus(ctx as never, { enabled: false, pinned: false, classifierEnabled: true, silent: false });
    assert.equal(calls[0]?.kind, "status");
    assert.equal(calls[0]?.key, "bifrost-state");
    assert.match(String(calls[0]?.value ?? ""), /Bifrost · off/);
    assert.equal(calls[1]?.key, "bifrost");
    assert.match(String(calls[1]?.value ?? "").replace(/\x1b\[[0-9;]*m/g, ""), /bifrost: unpinned ~ unsilence/);

    calls.length = 0;
    setBifrostModeStatus(ctx as never, {
      enabled: true,
      pinned: true,
      classifierEnabled: true,
      silent: true,
      thinkingMode: "advisory",
    });
    assert.equal(calls[0]?.kind, "status");
    assert.equal(calls[0]?.key, "bifrost-state");
    assert.match(String(calls[0]?.value ?? ""), /Bifrost · pinned · think:advisory/);
    assert.equal(calls[1]?.key, "bifrost");
    assert.match(String(calls[1]?.value ?? "").replace(/\x1b\[[0-9;]*m/g, ""), /bifrost: pinned ~ silence ~ think:advisory/);
  });

  it("refreshes when there is no prior refresh", () => {
    const state: RegistryRefreshState = {};
    assert.equal(shouldRefreshRegistry(state, 1_000, 30_000), true);
  });

  it("skips refresh within ttl", () => {
    const state: RegistryRefreshState = { lastRegistryRefreshAt: 1_000 };
    assert.equal(shouldRefreshRegistry(state, 20_000, 30_000), false);
  });

  it("refreshes after ttl expires", () => {
    const state: RegistryRefreshState = { lastRegistryRefreshAt: 1_000 };
    assert.equal(shouldRefreshRegistry(state, 40_000, 30_000), true);
  });

  it("forces refresh after explicit miss", () => {
    const state: RegistryRefreshState = {
      lastRegistryRefreshAt: 20_000,
      forceRegistryRefresh: true,
    };
    assert.equal(shouldRefreshRegistry(state, 21_000, 30_000), true);
  });

  it("deduplicates concurrent registry refreshes", async () => {
    const state: RegistryRefreshState = { forceRegistryRefresh: true };
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = refreshRegistry(state, async () => { calls++; await pending; });
    const second = refreshRegistry(state, async () => { calls++; });
    assert.equal(first, second);
    assert.equal(calls, 1);
    release();
    assert.equal(await first, true);
    assert.equal(state.forceRegistryRefresh, false);
    assert.equal(state.registryRefreshInflight, undefined);
  });

  it("keeps stale registry state after refresh failure", async () => {
    const state: RegistryRefreshState = { lastRegistryRefreshAt: 100, forceRegistryRefresh: true };
    const ok = await refreshRegistry(state, async () => { throw new Error("offline"); }, undefined, () => 200);
    assert.equal(ok, false);
    assert.equal(state.lastRegistryRefreshAt, 100);
    assert.equal(state.forceRegistryRefresh, true);
  });
});
