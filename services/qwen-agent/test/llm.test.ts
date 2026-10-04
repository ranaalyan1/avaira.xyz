import test from "node:test";
import assert from "node:assert/strict";
import { ScriptedMock, toolCall, thought } from "../src/llm.js";

test("ScriptedMock replays queued turns, then a safe default", async () => {
  const mock = new ScriptedMock("qwen3.8-max", [toolCall("c1", "treasury_balance", {}), thought("done")]);
  const first = await mock.chat([], []);
  assert.equal(first.tool_calls?.[0]?.function.name, "treasury_balance");
  const second = await mock.chat([], []);
  assert.equal(second.content, "done");
  const third = await mock.chat([], []);
  assert.match(third.content ?? "", /complete/);
});

test("toolCall serialises args as JSON", () => {
  const message = toolCall("id-1", "treasury_swap", { amountUsd: 5 });
  assert.equal(JSON.parse(message.tool_calls![0]!.function.arguments).amountUsd, 5);
});

test("thought carries reasoning text alongside optional calls", () => {
  const message = thought("planning", [{ id: "x", type: "function", function: { name: "n", arguments: "{}" } }]);
  assert.equal(message.content, "planning");
  assert.equal(message.tool_calls?.length, 1);
});
