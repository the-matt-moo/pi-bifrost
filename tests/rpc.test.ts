import assert from "node:assert/strict";
import test from "node:test";
import { handleRpcRequest } from "../rpc.ts";

test("classifyTask RPC returns model and thinking", async () => {
  const result = await handleRpcRequest(
    { version: 1, requestId: "r1", method: "classifyTask", params: { text: "fix the bug" } },
    async (text) => ({ model: "openai/gpt-5", thinking: { level: text ? "high" : "off" } }),
  );

  assert.deepEqual(result.reply, {
    version: 1,
    requestId: "r1",
    success: true,
    data: { model: "openai/gpt-5", thinking: { level: "high" } },
  });
});

test("classifyTask RPC validates requests", async () => {
  const result = await handleRpcRequest(
    { version: 2, requestId: "r2", method: "classifyTask", params: { text: "x" } },
    async () => null,
  );

  assert.equal(result.reply?.success, false);
});

test("classifyTask RPC converts classifier failures to replies", async () => {
  const result = await handleRpcRequest(
    { version: 1, requestId: "r3", method: "classifyTask", params: { text: "x" } },
    async () => { throw new Error("classifier unavailable"); },
  );

  assert.deepEqual(result.reply, {
    version: 1,
    requestId: "r3",
    success: false,
    error: "classifier unavailable",
  });
});
