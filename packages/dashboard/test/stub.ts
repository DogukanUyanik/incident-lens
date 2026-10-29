import assert from "node:assert/strict";
import type { MessagesClient } from "../../agent/src/agent.js";
import type { TelemetryClient } from "../../agent/src/mcp.js";

/** Scripted model and telemetry for running the real agent loop with no API call. */

type BetaMessage = Awaited<ReturnType<MessagesClient["beta"]["messages"]["create"]>>;

export const LOG_LINE = "[orders] acquired client (total=10 idle=0 waiting=5)";

export function message(stop_reason: string, content: unknown[], output_tokens = 100): BetaMessage {
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

export const callLogs = (id = "t1") =>
  message("tool_use", [
    { type: "text", text: "Checking order-service logs." },
    { type: "tool_use", id, name: "get_container_logs", input: { container: "order-service" } },
  ]);

export const submit = (quote = LOG_LINE) =>
  message("tool_use", [
    {
      type: "tool_use",
      id: "t-report",
      name: "submit_report",
      input: {
        summary: "GET /orders times out.",
        root_cause: "order-service leaks pool connections.",
        evidence: [{ source: 'get_container_logs {"container":"order-service"}', verbatim_quote: quote }],
      },
    },
  ]);

export function stubClient(responses: BetaMessage[]): MessagesClient {
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

export function stubTelemetry(text = `${LOG_LINE}\n`): TelemetryClient {
  return { tools: [], callTool: async () => ({ text, isError: false }), close: async () => {} };
}
