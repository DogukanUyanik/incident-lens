import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  createWithRetry,
  investigate,
  type MessagesClient,
  type TokenUsage,
} from "../packages/agent/src/agent.js";
import type { TelemetryClient } from "../packages/agent/src/mcp.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

const LOG_LINE = "[orders] acquired client (total=10 idle=0 waiting=5)";

function message(stop_reason: string, content: unknown[], output_tokens: number): BetaMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "stub-model",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens },
  } as unknown as BetaMessage;
}

const callLogs = message(
  "tool_use",
  [{ type: "tool_use", id: "t1", name: "get_container_logs", input: { container: "order-service" } }],
  50
);
const truncated = message("max_tokens", [{ type: "text", text: "x".repeat(40) }], 16000);
const submit = message(
  "tool_use",
  [
    {
      type: "tool_use",
      id: "t2",
      name: "submit_report",
      input: {
        summary: "GET /orders times out.",
        root_cause: "order-service leaks pool connections.",
        evidence: [{ source: 'get_container_logs {"container":"order-service"}', verbatim_quote: LOG_LINE }],
      },
    },
  ],
  300
);
const done = message("end_turn", [{ type: "text", text: "{}" }], 200);

/** Returns the scripted responses in order and keeps a deep copy of each request's messages. */
function stubClient(responses: BetaMessage[]) {
  const requests: unknown[] = [];
  const client: MessagesClient = {
    beta: {
      messages: {
        create: async (params) => {
          requests.push(structuredClone(params.messages));
          const next = responses.shift();
          assert.ok(next, "stub client: more calls than scripted responses");
          return next;
        },
      },
    },
  };
  return { client, requests };
}

const telemetry: TelemetryClient = {
  tools: [],
  callTool: async () => ({ text: `${LOG_LINE}\n`, isError: false }),
  close: async () => {},
};

test("agent retries a max_tokens turn once with the same request and then succeeds", async () => {
  const { client, requests } = stubClient([callLogs, truncated, submit]);
  const r = await investigate("alert", telemetry, client);

  assert.equal(r.ok, true, r.failure);
  assert.equal(r.retried, true);
  assert.equal(r.turns, 2);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2], requests[1], "the retry resends the truncated attempt's request unchanged");
  assert.deepEqual(r.usage, { input_tokens: 300, output_tokens: 50 + 16000 + 300 });
  assert.deepEqual(
    r.trace.map((t) => [t.turn, t.attempt, t.stop_reason, t.output_tokens]),
    [
      [1, 1, "tool_use", 50],
      [2, 1, "max_tokens", 16000],
      [2, 2, "tool_use", 300],
    ]
  );
  assert.deepEqual(r.trace[1].blocks, [{ type: "text", chars: 40 }]);
  assert.equal(r.trace[2].blocks[0].name, "submit_report");
});

test("agent fails as before when the retry also hits max_tokens", async () => {
  const { client, requests } = stubClient([truncated, truncated]);
  const r = await investigate("alert", telemetry, client);

  assert.equal(r.ok, false);
  assert.equal(r.failure, "stopped with stop_reason=max_tokens");
  assert.equal(r.retried, true);
  assert.equal(r.turns, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    r.trace.map((t) => [t.turn, t.attempt, t.stop_reason]),
    [
      [1, 1, "max_tokens"],
      [1, 2, "max_tokens"],
    ]
  );
});

test("agent without max_tokens makes one call per turn and is not marked retried", async () => {
  const { client, requests } = stubClient([callLogs, submit]);
  const r = await investigate("alert", telemetry, client);

  assert.equal(r.ok, true, r.failure);
  assert.equal(r.retried, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(r.trace.map((t) => t.attempt), [1, 1]);
});

// The baseline's single call goes through the same helper.

test("createWithRetry sends once when the response is not truncated", async () => {
  const { client, requests } = stubClient([done]);
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  const models: string[] = [];
  const attempts = await createWithRetry(client, { model: "m", max_tokens: 1, messages: [] }, usage, models);

  assert.equal(attempts.length, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(usage, { input_tokens: 100, output_tokens: 200 });
  assert.deepEqual(models, ["stub-model"]);
});

test("createWithRetry resends once on max_tokens and counts both attempts", async () => {
  const { client, requests } = stubClient([truncated, done]);
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  const attempts = await createWithRetry(client, { model: "m", max_tokens: 1, messages: [] }, usage, []);

  assert.deepEqual(attempts.map((a) => a.stop_reason), ["max_tokens", "end_turn"]);
  assert.equal(requests.length, 2);
  assert.deepEqual(usage, { input_tokens: 200, output_tokens: 16200 });
});

test("createWithRetry stops after the second max_tokens", async () => {
  const { client, requests } = stubClient([truncated, truncated, done]);
  const attempts = await createWithRetry(client, { model: "m", max_tokens: 1, messages: [] }, { input_tokens: 0, output_tokens: 0 }, []);

  assert.deepEqual(attempts.map((a) => a.stop_reason), ["max_tokens", "max_tokens"]);
  assert.equal(requests.length, 2);
});
