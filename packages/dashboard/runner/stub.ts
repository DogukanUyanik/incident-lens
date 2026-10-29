import type { MessagesClient, TokenUsage } from "../../agent/src/agent.js";
import type { TelemetryClient } from "../../agent/src/mcp.js";

/**
 * A scripted model and telemetry for AGENT_STUB=1: drives the real agent loop end to end with no API call and no
 * Docker. The text says it is a stub, so a recording made this way can't be mistaken for a real run.
 */

type BetaMessage = Awaited<ReturnType<MessagesClient["beta"]["messages"]["create"]>>;

export const STUB_LOG_LINE = "[stub] this line comes from the stub telemetry, not from the sandbox";

export function message(stop_reason: string, content: unknown[], output_tokens = 100): BetaMessage {
  const usage: TokenUsage & Record<string, unknown> = { input_tokens: 100, output_tokens };
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "stub-model",
    content,
    stop_reason,
    stop_sequence: null,
    usage,
  } as unknown as BetaMessage;
}

export function stubScript(): BetaMessage[] {
  return [
    message("tool_use", [
      { type: "text", text: "[stub] Checking the logs." },
      { type: "tool_use", id: "stub-1", name: "get_container_logs", input: { container: "stub" } },
    ]),
    message("tool_use", [
      {
        type: "tool_use",
        id: "stub-2",
        name: "submit_report",
        input: {
          summary: "[stub] This report comes from the stub agent.",
          root_cause: "[stub] No real investigation ran; this checks the event pipeline only.",
          evidence: [{ source: 'get_container_logs {"container":"stub"}', verbatim_quote: STUB_LOG_LINE }],
        },
      },
    ]),
  ];
}

export function stubClient(responses: BetaMessage[], delayMs = 0): MessagesClient {
  return {
    beta: {
      messages: {
        create: async () => {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          const next = responses.shift();
          if (!next) throw new Error("stub client: more calls than scripted responses");
          return next;
        },
      },
    },
  };
}

export function stubTelemetry(text = `${STUB_LOG_LINE}\n`): TelemetryClient {
  return { tools: [], callTool: async () => ({ text, isError: false }), close: async () => {} };
}
