import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEscapeKey, wrapResultLines } from "../result-viewer.ts";

describe("result viewer", () => {
  it("wraps long lines without dropping text", () => {
    const source = "selected: provider/very-long-model-name-with-every-detail";
    const lines = wrapResultLines([source], 12);

    assert(lines.length > 1);
    assert.equal(lines.join(""), source);
    assert(lines.every((line) => line.length <= 12));
  });

  it("keeps blank lines between result sections", () => {
    assert.deepEqual(wrapResultLines(["tier: frontier", "", "candidates:"], 40), [
      "tier: frontier",
      "",
      "candidates:",
    ]);
  });

  it("recognizes terminal escape encodings", () => {
    assert.equal(isEscapeKey("\x1b"), true);
    assert.equal(isEscapeKey("\x1b[27u"), true);
    assert.equal(isEscapeKey("\x1b[27;1u"), true);
    assert.equal(isEscapeKey("\x1b[27;1;27~"), true);
    assert.equal(isEscapeKey("j"), false);
  });

  it("splits multiline strings within an item into separate lines", () => {
    const raw = "proposed config:\n{\n  \"models\": {\n    \"heavy\": [\n      \"anthropic/claude\"\n    ]\n  }\n}";
    const lines = wrapResultLines([raw], 40);

    assert(lines.every((line) => !line.includes("\n") && !line.includes("\r")));
    assert.equal(lines[0], "proposed config:");
    assert.equal(lines[1], "{");
    assert.equal(lines[2], "  \"models\": {");
  });

  it("expands tabs to avoid horizontal overflow", () => {
    const lines = wrapResultLines(["\t+ model -> tier"], 40);
    assert.equal(lines[0], "  + model -> tier");
  });
});
