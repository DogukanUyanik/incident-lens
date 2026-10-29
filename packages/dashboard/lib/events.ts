import { z } from "zod";

/**
 * The one event schema shared by replay and live runs. A run is a sequence of these, one JSON object per line in a
 * replay file (.ndjson), starting with run_start and ending with run_end.
 */
export const SCHEMA_VERSION = 1;

const usage = z.object({ input_tokens: z.number(), output_tokens: z.number() });

const report = z.object({
  summary: z.string(),
  root_cause: z.string(),
  evidence: z.array(z.object({ source: z.string(), verbatim_quote: z.string() })),
});

// Same fields as packages/agent/src/verifier.ts EvidenceCheck.
const check = z.object({
  source: z.string(),
  quote: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  matchedIn: z.array(z.string()),
  sourceMismatch: z.boolean(),
});

const envelope = {
  v: z.literal(SCHEMA_VERSION),
  run_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  /** Milliseconds since run_start; null when the timing was not recorded (reconstructed replays). */
  t_ms: z.number().nonnegative().nullable(),
};

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ ...envelope, type: z.literal(type), ...shape }).strict();

export const RunEvent = z.discriminatedUnion("type", [
  event("run_start", {
    scenario_id: z.string(),
    alert: z.string(),
    model: z.string(),
    mode: z.enum(["replay", "live"]),
    /** live: recorded from a real run as it happened; reconstructed: rebuilt afterwards from stored results. */
    source: z.enum(["live", "reconstructed"]),
    started_at: z.string().optional(),
    note: z.string().optional(),
  }),
  event("turn_start", { turn: z.number().int().positive(), max_turns: z.number().int().positive() }),
  event("retry", { turn: z.number().int().positive(), reason: z.literal("max_tokens") }),
  event("assistant_text", { turn: z.number().int().positive(), text: z.string() }),
  event("thinking", { turn: z.number().int().positive(), text: z.string(), chars: z.number().int().nonnegative() }),
  event("tool_call", {
    turn: z.number().int().positive(),
    id: z.string(),
    name: z.string(),
    /** null when not recorded (reconstructed replays). */
    args: z.record(z.string(), z.unknown()).nullable(),
  }),
  event("tool_result", {
    turn: z.number().int().positive(),
    id: z.string(),
    name: z.string(),
    is_error: z.boolean(),
    text: z.string(),
    /** The MCP server cut the output to its 4000-char cap. */
    truncated: z.boolean(),
  }),
  event("report_submitted", { turn: z.number().int().positive(), report: z.unknown() }),
  event("verification", {
    turn: z.number().int().positive(),
    ok: z.boolean(),
    checks: z.array(check),
    reason: z.string().optional(),
  }),
  event("report_final", { report, checks: z.array(check), turns: z.number().int().positive(), usage }),
  event("error", { stage: z.enum(["agent", "runner", "mcp"]), message: z.string() }),
  event("run_end", {
    ok: z.boolean(),
    failure: z.string().optional(),
    /** null when the run crashed before the agent returned. */
    turns: z.number().int().nonnegative().nullable(),
    usage: usage.nullable(),
    seconds: z.number().nonnegative().nullable(),
  }),
]);

export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];

/** Distributes Omit over the union, so each event type keeps its own fields. */
type OmitEnvelope<T> = T extends unknown ? Omit<T, keyof typeof envelope> : never;
/** An event before the recorder adds v, run_id, seq and t_ms. */
export type EventBody = OmitEnvelope<RunEvent>;
