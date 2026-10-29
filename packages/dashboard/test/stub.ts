import { message, stubClient, stubTelemetry as runnerTelemetry } from "../runner/stub";

/** Test helpers on top of the runner's stub (runner/stub.ts). */

export { message, stubClient };

export const LOG_LINE = "[orders] acquired client (total=10 idle=0 waiting=5)";

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

export const stubTelemetry = (text = `${LOG_LINE}\n`) => runnerTelemetry(text);
