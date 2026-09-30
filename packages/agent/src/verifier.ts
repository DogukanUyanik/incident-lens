import type { IncidentReport } from "./report.js";

export const MIN_QUOTE_LENGTH = 12;

interface RecordedResult {
  name: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
}

export interface EvidenceCheck {
  source: string;
  quote: string;
  ok: boolean;
  reason?: string;
  matchedIn: string[];
  sourceMismatch: boolean;
}

export function callLabel(name: string, args: Record<string, unknown>): string {
  return `${name} ${JSON.stringify(args)}`;
}

/** Loose check that a free-text `source` refers to this call: names the tool and each string argument. */
function sourceRefersTo(source: string, r: RecordedResult): boolean {
  return (
    source.includes(r.name) &&
    Object.values(r.args).every((v) => typeof v !== "string" || source.includes(v))
  );
}

/**
 * Records the exact text of every tool result shown to the model during a run, and checks that
 * each evidence quote in a submitted report is a literal substring of at least one of them.
 */
export class CitationVerifier {
  private results: RecordedResult[] = [];

  record(name: string, args: Record<string, unknown>, text: string, isError: boolean) {
    this.results.push({ name, args, text, isError });
  }

  verify(report: IncidentReport): { ok: boolean; checks: EvidenceCheck[] } {
    const eligible = this.results.filter((r) => !r.isError);
    const checks = report.evidence.map(({ source, verbatim_quote: quote }): EvidenceCheck => {
      if (quote.trim().length < MIN_QUOTE_LENGTH) {
        return {
          source,
          quote,
          ok: false,
          reason: `too short to be meaningful evidence (minimum ${MIN_QUOTE_LENGTH} characters)`,
          matchedIn: [],
          sourceMismatch: false,
        };
      }
      const matches = eligible.filter((r) => r.text.includes(quote));
      if (matches.length === 0) {
        return {
          source,
          quote,
          ok: false,
          reason: "not found verbatim in any tool output from this investigation",
          matchedIn: [],
          sourceMismatch: false,
        };
      }
      // `source` is informational only: warn when the quote was found, but not in the call it names.
      const sourceMismatch = !matches.some((r) => sourceRefersTo(source, r));
      const matchedIn = [...new Set(matches.map((r) => callLabel(r.name, r.args)))];
      return { source, quote, ok: true, matchedIn, sourceMismatch };
    });
    return { ok: checks.every((c) => c.ok), checks };
  }
}
