import type { RunEvent } from "../../lib/events";

/**
 * Turns a run's evidence checks into citations for the report panel. A check records the tool calls its quote was
 * found in as labels ("get_container_logs {"container":"gateway","tail":50}", from verifier.callLabel); the tool
 * result is attached only when the run recorded that call's output (live runs). Reconstructed replays have none.
 */

type Check = Extract<RunEvent, { type: "report_final" }>["checks"][number];

export interface Citation {
  quote: string;
  verified: boolean;
  reason?: string;
  /** The call the quote was verified in (or, if it wasn't, the call the report named). */
  label: string;
  tool: string;
  container: string | null;
  sourceMismatch: boolean;
  result?: { text: string; truncated: boolean; is_error: boolean };
}

export function callLabel(name: string, args: Record<string, unknown>): string {
  return `${name} ${JSON.stringify(args)}`;
}

export function parseLabel(label: string): { tool: string; container: string | null } {
  const i = label.indexOf(" ");
  const tool = i < 0 ? label : label.slice(0, i);
  let container: string | null = null;
  if (i >= 0) {
    try {
      const args = JSON.parse(label.slice(i + 1)) as Record<string, unknown>;
      if (typeof args.container === "string") container = args.container;
      else if (typeof args.service === "string") container = args.service;
    } catch {
      // The report's free-text source, not a recorded label: show the tool name only.
    }
  }
  return { tool, container };
}

/** Tool output per call label, from the tool_call/tool_result pairs of the run. */
function resultsByLabel(events: RunEvent[]): Map<string, NonNullable<Citation["result"]>> {
  const labels = new Map<string, string>();
  const out = new Map<string, NonNullable<Citation["result"]>>();
  for (const e of events) {
    if (e.type === "tool_call" && e.args) labels.set(e.id, callLabel(e.name, e.args));
    if (e.type === "tool_result") {
      const label = labels.get(e.id);
      if (label && !out.has(label)) out.set(label, { text: e.text, truncated: e.truncated, is_error: e.is_error });
    }
  }
  return out;
}

/** Citations of the accepted report, or of the last verification when the run ended without one. */
export function citationsOf(events: RunEvent[]): Citation[] {
  const final = [...events].reverse().find((e) => e.type === "report_final");
  const checks: Check[] | undefined =
    final?.type === "report_final"
      ? final.checks
      : (([...events].reverse().find((e) => e.type === "verification") as Extract<RunEvent, { type: "verification" }> | undefined)
          ?.checks ?? undefined);
  if (!checks) return [];
  const results = resultsByLabel(events);
  return checks.map((c) => {
    const label = c.matchedIn[0] ?? c.source;
    return {
      quote: c.quote,
      verified: c.ok,
      reason: c.reason,
      label,
      ...parseLabel(label),
      sourceMismatch: c.sourceMismatch,
      result: c.matchedIn.map((l) => results.get(l)).find((r) => r !== undefined),
    };
  });
}

/** Splits text around the first occurrence of quote, for highlighting. */
export function splitAround(text: string, quote: string): [string, string, string] | null {
  const i = quote ? text.indexOf(quote) : -1;
  return i < 0 ? null : [text.slice(0, i), quote, text.slice(i + quote.length)];
}
