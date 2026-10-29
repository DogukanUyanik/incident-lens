import { MAX_TURNS, type TokenUsage, type TurnTrace } from "../../agent/src/agent.js";
import type { IncidentReport } from "../../agent/src/report.js";
import type { EvidenceCheck } from "../../agent/src/verifier.js";
import { SCHEMA_VERSION, type EventBody, type RunEvent } from "./events";

/** The fields of evals/results/<id>.json this needs (written by evals/run-benchmark.ts). */
export interface StoredRun {
  approach: "agent" | "baseline";
  run: number;
  ok: boolean;
  report?: IncidentReport;
  checks?: EvidenceCheck[];
  grade?: { correct: boolean };
  usage: TokenUsage;
  models: string[];
  seconds: number;
  turns?: number;
  trace?: TurnTrace[];
}

export interface StoredResult {
  id: string;
  startedAt: string;
  model: string;
  runs: StoredRun[];
}

/** The first agent run that produced a report graded correct. */
export function pickRun(result: StoredResult): StoredRun | undefined {
  return result.runs.find((r) => r.approach === "agent" && r.ok && r.grade?.correct && r.report && r.checks);
}

/** "get_container_logs {"container":"x"}" → name and the exact JSON text of its arguments (verifier.callLabel). */
function splitLabel(label: string): { name: string; json: string } {
  const i = label.indexOf(" ");
  return i < 0 ? { name: label, json: "" } : { name: label.slice(0, i), json: label.slice(i + 1) };
}

/**
 * Rebuilds a replay from a stored benchmark run, using only what was stored. Nothing is invented:
 * - the agent's text, thinking and the tool outputs were never stored, so there are no assistant_text, thinking or
 *   tool_result events, and no timings (t_ms is null);
 * - turns and tool calls exist only when the run has a trace, and a call's arguments are filled in only when exactly
 *   one cited call (a `matchedIn` label) and exactly one traced call share both the tool name and the length of the
 *   argument JSON (the trace stores that length); otherwise args is null;
 * - report, checks, usage, turns and seconds are the stored originals.
 * Tool call ids are placeholders ("reconstructed-t<turn>-<n>"): the real ids were not stored.
 */
export function reconstruct(result: StoredResult, run: StoredRun, alert: string): RunEvent[] {
  if (!run.report || !run.checks || run.turns === undefined) throw new Error(`${result.id}: run ${run.run} has no report`);
  const runId = `reconstructed-${result.id}-run${run.run}`;
  let seq = 0;
  const events: RunEvent[] = [];
  const push = (body: EventBody) =>
    events.push({ v: SCHEMA_VERSION, run_id: runId, seq: seq++, t_ms: null, ...body } as RunEvent);

  const trace = run.trace ?? [];
  push({
    type: "run_start",
    scenario_id: result.id,
    alert,
    model: run.models[0] ?? result.model,
    mode: "replay",
    source: "reconstructed",
    note:
      `Rebuilt from stored benchmark results (evals/results/${result.id}.json, session ${result.startedAt}, ` +
      `agent run ${run.run}). The agent's text, its thinking and the tool outputs were not recorded. ` +
      (trace.length
        ? "Turns and tool names come from the run's trace; arguments are shown only where a citation identifies the call. "
        : "This run predates the per-turn trace, so its turns and tool calls are not available. ") +
      "The report, citations and verification are the stored originals.",
  });

  // Unambiguous argument matches: (tool name, JSON length) → args, only when unique on both sides.
  const cited = [...new Set(run.checks.flatMap((c) => c.matchedIn))].map(splitLabel);
  const final = new Map<number, TurnTrace>();
  for (const t of trace) if ((final.get(t.turn)?.attempt ?? 0) < t.attempt) final.set(t.turn, t);
  const calls = [...final.values()].flatMap((t) =>
    t.blocks.filter((b) => b.type === "tool_use" && b.name !== "submit_report").map((b) => ({ name: b.name!, chars: b.chars }))
  );
  const argsFor = (name: string, chars: number | undefined): Record<string, unknown> | null => {
    const labels = cited.filter((l) => l.name === name && l.json.length === chars);
    const traced = calls.filter((c) => c.name === name && c.chars === chars);
    return labels.length === 1 && traced.length === 1 ? (JSON.parse(labels[0].json) as Record<string, unknown>) : null;
  };

  for (const t of [...final.values()].sort((a, b) => a.turn - b.turn)) {
    push({ type: "turn_start", turn: t.turn, max_turns: MAX_TURNS });
    if (t.attempt > 1) push({ type: "retry", turn: t.turn, reason: "max_tokens" });
    let n = 0;
    for (const b of t.blocks) {
      if (b.type !== "tool_use" || b.name === "submit_report") continue;
      push({ type: "tool_call", turn: t.turn, id: `reconstructed-t${t.turn}-${++n}`, name: b.name!, args: argsFor(b.name!, b.chars) });
    }
  }

  push({ type: "report_submitted", turn: run.turns, report: run.report });
  push({ type: "verification", turn: run.turns, ok: run.checks.every((c) => c.ok), checks: run.checks });
  push({ type: "report_final", report: run.report, checks: run.checks, turns: run.turns, usage: run.usage });
  push({ type: "run_end", ok: true, turns: run.turns, usage: run.usage, seconds: run.seconds });
  return events;
}

export const toNdjson = (events: RunEvent[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
