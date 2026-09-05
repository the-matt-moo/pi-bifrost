import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELIABILITY,
  emptyReliabilityState,
  getCircuitState,
  isRetryableProviderLimit,
  loadReliability,
  recordModelFailure,
  recordModelSuccess,
  beginTrial,
  reliabilityPath,
  saveReliability,
} from "../reliability.ts";

describe("reliability", () => {
  it("recognizes provider-side limit rejections safe for bounded retry", () => {
    for (const reason of [
      "429: temporarily rate-limited upstream",
      "ResourceExhausted: Worker local total request limit reached",
      "Quota reached. Please wait 3h",
      "This request would exceed your account's rate limit",
      "Error: Codex error: The usage limit has been reached",
      '{"error":{"type":"rate_limit_error","message":"limit exceeded"}}',
      "Insufficient credits. Please add funds.",
    ]) {
      assert.equal(isRetryableProviderLimit(reason), true, reason);
    }
    assert.equal(isRetryableProviderLimit("500: provider failed after partial output"), false);
  });

  it("opens circuit after threshold failures within window", () => {
    const cfg = {
      ...DEFAULT_RELIABILITY,
      failureThreshold: 3,
      windowMinutes: 5,
      cooldownMinutes: 60,
    };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 60_000, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 120_000, "probe", "timeout");

    const circuit = getCircuitState(state, key, t0 + 120_000, cfg);
    assert.equal(circuit.open, true);
    assert.equal(circuit.recentFailures, 3);
    assert.equal(circuit.openUntil, t0 + 120_000 + 60 * 60_000);
  });

  it("does not record failures when reliability is disabled", () => {
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const state = recordModelFailure(
      emptyReliabilityState(),
      key,
      { enabled: false, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 },
      t0,
      "probe",
      "timeout",
    );
    assert.deepEqual(state, emptyReliabilityState());
  });

  it("closes circuit on successful probe", () => {
    const cfg = {
      ...DEFAULT_RELIABILITY,
      failureThreshold: 3,
      windowMinutes: 5,
      cooldownMinutes: 60,
    };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 60_000, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 120_000, "probe", "timeout");
    state = recordModelSuccess(state, key, t0 + 180_000, "probe");

    const circuit = getCircuitState(state, key, t0 + 180_000, cfg);
    assert.equal(circuit.open, false);
    assert.equal(circuit.recentFailures, 0);
  });

  it("saves and loads persisted state", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-reliability-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = cwd;
    try {
      const path = reliabilityPath(cwd);
      const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
      let state = emptyReliabilityState();
      state = recordModelFailure(state, "openai/gpt-5.4", DEFAULT_RELIABILITY, t0, "probe", "timeout");
      saveReliability(path, state);
      const loaded = loadReliability(path);
      assert.equal(loaded.version, 1);
      assert.deepEqual(loaded.models["openai/gpt-5.4"]?.failures, [t0]);
      assert.equal(loaded.models["openai/gpt-5.4"]?.lastFailureSource, "probe");
      assert.equal(loaded.models["openai/gpt-5.4"]?.lastFailureReason, "timeout");
    } finally {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns empty state for missing persisted file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-reliability-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = cwd;
    try {
      const path = reliabilityPath(cwd);
      assert.deepEqual(loadReliability(path), emptyReliabilityState());
    } finally {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns empty state for corrupt persisted file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-reliability-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = cwd;
    try {
      const path = reliabilityPath(cwd);
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "bifrost-reliability.json"), "{not json", "utf8");
      const loaded = loadReliability(path);
      assert.deepEqual(loaded, emptyReliabilityState());
    } finally {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails open with malformed-but-valid JSON records", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-reliability-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = cwd;
    try {
      const path = reliabilityPath(cwd);
      mkdirSync(cwd, { recursive: true });
      const malformed = JSON.stringify({
        version: 1,
        models: {
          "openai/demo": { failures: "invalid" },
          "openai/ok": { failures: [ Date.UTC(2026, 0, 1, 12, 0, 0) ], openUntil: "not-a-number" },
          "openai/skipped-nested": { failures: { not: "array" } },
          "": { openUntil: Infinity },
        },
      });
      writeFileSync(join(cwd, "bifrost-reliability.json"), malformed, "utf8");
      const loaded = loadReliability(path);
      assert.equal(loaded.version, 1);
      assert.equal(typeof loaded.models, "object");
      for (const key of Object.keys(loaded.models)) {
        const record = loaded.models[key]!;
        assert.ok(Array.isArray(record.failures), `failures should be array for ${key}`);
        if (record.openUntil !== undefined) assert.ok(Number.isFinite(record.openUntil), `openUntil should be finite for ${key}`);
      }
      const circuit = getCircuitState(loaded, "openai/demo", Date.UTC(2026, 0, 1, 12, 0, 0), DEFAULT_RELIABILITY);
      assert.equal(circuit.open, false);
      assert.equal(circuit.recentFailures, 0);
    } finally {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("opens circuit immediately on HTTP 4xx error", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openrouter/nvidia/test:free";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const reason = 'Error: 429: {"message":"Provider returned error","code":429}';
    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "settled", reason);
    const circuit = getCircuitState(state, key, t0, cfg);
    assert.equal(circuit.open, true, "circuit should open on first 429");
    assert.equal(circuit.recentFailures, 1);
  });

  it("opens circuit immediately on HTTP 5xx error", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openrouter/test/model";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "settled", "Error: 502 Bad Gateway");
    assert.equal(getCircuitState(state, key, t0, cfg).open, true);
  });

  it("does not immediately open circuit on non-HTTP probe errors", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openrouter/test/model";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "probe", "timeout");
    assert.equal(getCircuitState(state, key, t0, cfg).open, false, "should not open on generic probe timeout");
  });

  it("opens circuit immediately on settled runtime errors", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openrouter/nvidia/test:free";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const reason = "Error: Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached";
    const state = recordModelFailure(emptyReliabilityState(), key, cfg, t0, "agent_settled", reason);
    assert.equal(getCircuitState(state, key, t0, cfg).open, true);
  });

  it("half-open: allows one trial after cooldown, closes on success", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let state = recordModelFailure(emptyReliabilityState(), key, cfg, t0, "probe", "timeout");
    assert.equal(getCircuitState(state, key, t0, cfg).open, true);
    assert.equal(getCircuitState(state, key, t0, cfg).halfOpen, false);
    const t1 = t0 + 61 * 60_000;
    assert.equal(getCircuitState(state, key, t1, cfg).open, false);
    assert.equal(getCircuitState(state, key, t1, cfg).halfOpen, true);
    assert.equal(getCircuitState(state, key, t1, cfg).trialActive, false);
    state = beginTrial(state, key);
    assert.equal(getCircuitState(state, key, t1, cfg).trialActive, true);
    state = recordModelSuccess(state, key, t1 + 1, "trial");
    const closed = getCircuitState(state, key, t1 + 1, cfg);
    assert.equal(closed.open, false);
    assert.equal(closed.halfOpen, false);
    assert.equal(closed.trialActive, false);
  });

  it("half-open: trial failure reopens circuit with double cooldown", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let state = recordModelFailure(emptyReliabilityState(), key, cfg, t0, "probe", "timeout");
    const t1 = t0 + 61 * 60_000;
    state = beginTrial(state, key);
    state = recordModelFailure(state, key, cfg, t1, "trial", "timeout");
    const circuit = getCircuitState(state, key, t1, cfg);
    assert.equal(circuit.open, true);
    assert.equal(circuit.openUntil, t1 + 120 * 60_000);
    assert.equal(circuit.trialActive, false);
  });
});
