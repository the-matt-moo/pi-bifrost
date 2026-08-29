import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionRoutingContext } from "../session-context.ts";

describe("SessionRoutingContext topic changes", () => {
  it("only treats a substantial prompt with no session overlap as clearly unrelated", () => {
    const context = new SessionRoutingContext();
    context.record("general", "fix bifrost fallback model auto pin behavior");

    assert.equal(context.isClearlyUnrelated("make the fallback model remain pinned"), false);
    assert.equal(context.isClearlyUnrelated("please proceed"), false);
    assert.equal(context.isClearlyUnrelated("explain sourdough starter feeding schedule"), true);
    assert.equal(context.isClearlyUnrelated("docker logs"), true);
    assert.equal(context.isClearlyUnrelated("sql help"), true);
  });

  it("tracks rolling pinned-session prompts", () => {
    const context = new SessionRoutingContext();
    context.record("general", "debug payment webhook retries");
    context.record("general", "inspect webhook signature validation");

    assert.equal(context.isClearlyUnrelated("fix signature validation error"), false);
  });
});
