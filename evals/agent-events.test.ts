import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { investigate, type AgentEvent, type MessagesClient } from "../packages/agent/src/agent.js";
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

const callLogs = () =>
  message(
    "tool_use",
    [
      { type: "text", text: "Checking order-service logs." },
      { type: "tool_use", id: "t1", name: "get_container_logs", input: { container: "order-service" } },
    ],
    50
  );
const submit = (quote: string, id = "t2") =>
  message(
    "tool_use",
    [
      { type: "thinking", thinking: "pool is full", signature: "sig" },
      {
        type: "tool_use",
        id,
        name: "submit_report",
        input: {
          summary: "GET /orders times out.",
          root_cause: "order-service leaks pool connections.",
          evidence: [{ source: 'get_container_logs {"container":"order-service"}', verbatim_quote: quote }],
        },
      },
    ],
    300
  );
const truncated = () => message("max_tokens", [{ type: "text", text: "never shown" }], 16000);

function stubClient(responses: BetaMessage[]): MessagesClient {
  return {
    beta: {
      messages: {
        create: async () => {
          const next = responses.shift();
          assert.ok(next, "stub client: more calls than scripted responses");
          return next;
        },
      },
    },
  };
}

const telemetry: TelemetryClient = {
  tools: [],
  callTool: async () => ({ text: `${LOG_LINE}\n`, isError: false }),
  close: async () => {},
};

async function run(responses: BetaMessage[], onEvent?: (e: AgentEvent) => void) {
  return investigate("alert", telemetry, stubClient(responses), onEvent);
}

test("a normal run emits the turn, text, tool, report and verification events in order", async () => {
  const events: AgentEvent[] = [];
  const r = await run([callLogs(), submit(LOG_LINE)], (e) => events.push(e));

  assert.equal(r.ok, true, r.failure);
  assert.deepEqual(
    events.map((e) => `${e.type}${"turn" in e ? `@${e.turn}` : ""}`),
    [
      "turn_start@1",
      "assistant_text@1",
      "tool_call@1",
      "tool_result@1",
      "turn_start@2",
      "thinking@2",
      "report_submitted@2",
      "verification@2",
      "report_final", // carries `turns` (the total), not `turn`
    ]
  );
  const call = events.find((e) => e.type === "tool_call");
  assert.deepEqual(call, {
    type: "tool_call",
    turn: 1,
    id: "t1",
    name: "get_container_logs",
    args: { container: "order-service" },
  });
  const result = events.find((e) => e.type === "tool_result");
  assert.deepEqual(result, {
    type: "tool_result",
    turn: 1,
    id: "t1",
    name: "get_container_logs",
    is_error: false,
    text: `${LOG_LINE}\n`,
  });
  const final = events.at(-1);
  assert.ok(final?.type === "report_final");
  assert.equal(final.turns, 2);
  assert.deepEqual(final.checks, r.checks);
  assert.deepEqual(final.usage, r.usage);
});

test("the result is the same with no listener, a listener, a throwing listener and a mutating listener", async () => {
  const script = () => [callLogs(), submit(LOG_LINE)];
  const plain = await run(script());
  const listened = await run(script(), () => {});
  const throwing = await run(script(), () => {
    throw new Error("listener bug");
  });
  const mutating = await run(script(), (e) => {
    if (e.type === "tool_call") e.args.container = "postgres";
    if (e.type === "verification") e.checks.length = 0;
  });

  for (const r of [listened, throwing, mutating]) assert.deepEqual(r, plain);
});

test("a max_tokens retry emits a retry event and nothing from the dropped attempt", async () => {
  const events: AgentEvent[] = [];
  const r = await run([callLogs(), truncated(), submit(LOG_LINE)], (e) => events.push(e));

  assert.equal(r.ok, true, r.failure);
  assert.equal(r.retried, true);
  assert.deepEqual(
    events.filter((e) => e.type === "retry"),
    [{ type: "retry", turn: 2, reason: "max_tokens" }]
  );
  assert.ok(!events.some((e) => e.type === "assistant_text" && e.text === "never shown"));
});

test("a rejected quote emits a failed verification and no report_final", async () => {
  const events: AgentEvent[] = [];
  const r = await run([callLogs(), submit("this line was never in any tool output"), submit(LOG_LINE, "t3")], (e) =>
    events.push(e)
  );

  assert.equal(r.ok, true, r.failure);
  const verifications = events.filter((e) => e.type === "verification");
  assert.deepEqual(
    verifications.map((v) => [v.turn, v.ok]),
    [
      [2, false],
      [3, true],
    ]
  );
  assert.equal(events.filter((e) => e.type === "report_final").length, 1);
});
