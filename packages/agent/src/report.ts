import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";

export const SUBMIT_REPORT = "submit_report";

export const IncidentReport = z.object({
  summary: z.string().min(1).describe("One or two sentences: what is broken and the impact"),
  root_cause: z.string().min(1).describe("The underlying cause, not just the symptom"),
  evidence: z
    .array(
      z.object({
        source: z
          .string()
          .min(1)
          .describe('The tool call the quote came from, e.g. get_container_logs {"container":"gateway"}'),
        verbatim_quote: z
          .string()
          .min(1)
          .describe("Text copied exactly, character for character, from that tool call's output"),
      })
    )
    .min(1),
});

export type IncidentReport = z.infer<typeof IncidentReport>;

// Strict tool use does not accept length/count constraints, so drop them from the schema sent to the API.
// They are still enforced locally: the agent re-parses every submit_report input with IncidentReport.
const UNSUPPORTED_IN_STRICT = new Set(["$schema", "minLength", "maxLength", "minItems", "maxItems"]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !UNSUPPORTED_IN_STRICT.has(key))
      .map(([key, value]) => [key, stripUnsupported(value)])
  );
}

const reportSchema = stripUnsupported(z.toJSONSchema(IncidentReport));

export const submitReportTool: Anthropic.Beta.Messages.BetaTool = {
  name: SUBMIT_REPORT,
  description:
    "Submit the final incident report. Call this exactly once you have identified the root cause. " +
    "Every evidence quote is checked against the raw tool output seen in this investigation; " +
    "if any quote is not an exact substring, the report is rejected and you must fix it and resubmit.",
  strict: true,
  input_schema: reportSchema as Anthropic.Beta.Messages.BetaTool["input_schema"],
};
