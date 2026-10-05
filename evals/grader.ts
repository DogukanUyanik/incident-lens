import type { IncidentReport } from "../packages/agent/src/report.js";
import type { EvidenceCheck } from "../packages/agent/src/verifier.js";
import type { Grading } from "./scenarios.js";

/**
 * Code-based root-cause grader, driven by each scenario's `grading` in scenarios.json: a run is correct iff every
 * keyword group matches. A keyword proxy, not understanding: known false positives are hedged multi-cause answers
 * and negations it doesn't recognise; known false negatives are phrasings outside the patterns. Per-run root
 * causes are printed for eyeballing.
 */

// A negator shortly before a match of a negatable group cancels that match. Whole words only, so "now"/"another"
// don't count as "no".
const NEGATOR = /\b(not|no|isn't|rather than|ruled out|unlikely)\b/;
const NEGATION_WINDOW = 30;

export interface GroupResult {
  name: string;
  matched: boolean;
  negated: number;
}

export interface Grade {
  correct: boolean;
  groups: GroupResult[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

export function gradeRootCause(report: Pick<IncidentReport, "root_cause" | "summary">, grading: Grading): Grade {
  const cause = normalize(report.root_cause);
  const summary = normalize(report.summary);

  const groups = grading.groups.map((group): GroupResult => {
    const texts = group.scope === "root_cause_or_summary" ? [cause, summary] : [cause];
    let matched = false;
    let negated = 0;
    for (const text of texts) {
      for (const source of group.patterns) {
        for (const m of text.matchAll(new RegExp(source, "g"))) {
          const before = text.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
          // Patterns such as "not releas" carry their own negation; the window starts at the match, so they count.
          if (group.negatable && NEGATOR.test(before)) negated++;
          else matched = true;
        }
      }
    }
    return { name: group.name, matched, negated };
  });

  return { correct: groups.every((g) => g.matched), groups };
}

export function describeGrade(g: Grade): string {
  return g.groups
    .map((r) => `${r.name}${r.matched ? "✔" : "✘"}${r.negated ? ` neg×${r.negated}` : ""}`)
    .join(" ");
}

/** Share of evidence quotes that verified as literal substrings of the text the approach saw. */
export function citationValidity(checks: EvidenceCheck[]): { ok: number; total: number; share: number } {
  const ok = checks.filter((c) => c.ok).length;
  return { ok, total: checks.length, share: checks.length ? ok / checks.length : 0 };
}
