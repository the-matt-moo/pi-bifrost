import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  pendingRemoteTexts,
  queueRemoteText,
  consumeRemoteText,
  REMOTE_QUEUE_CAP,
} from "../remote-signal.ts";

describe("remote-prompt signal queue", () => {
  beforeEach(() => {
    pendingRemoteTexts.length = 0;
  });

  it("does not match when the queue is empty", () => {
    assert.equal(consumeRemoteText("hello"), false);
  });

  it("matches and removes a queued text once", () => {
    queueRemoteText("hello from phone");
    assert.equal(consumeRemoteText("hello from phone"), true);
    assert.equal(consumeRemoteText("hello from phone"), false);
  });

  it("does not match other text", () => {
    queueRemoteText("hello");
    assert.equal(consumeRemoteText("goodbye"), false);
    assert.equal(pendingRemoteTexts.length, 1);
  });

  it("removes only the first duplicate", () => {
    queueRemoteText("dup");
    queueRemoteText("dup");
    assert.equal(consumeRemoteText("dup"), true);
    assert.deepEqual([...pendingRemoteTexts], ["dup"]);
  });

  it("caps the queue, dropping the oldest", () => {
    for (let i = 0; i < REMOTE_QUEUE_CAP + 5; i++) queueRemoteText(`msg-${i}`);
    assert.equal(pendingRemoteTexts.length, REMOTE_QUEUE_CAP);
    assert.equal(consumeRemoteText("msg-0"), false);
    assert.equal(consumeRemoteText("msg-5"), true);
  });
});
