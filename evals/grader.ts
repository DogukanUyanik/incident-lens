import type { IncidentReport } from "../packages/agent/src/report.js";
import type { EvidenceCheck } from "../packages/agent/src/verifier.js";

/**
 * Code-based root-cause grader for scenario 1 (order-service connection pool leak). A keyword proxy, not
 * understanding: known false positives are hedged multi-cause answers and negations it doesn't recognise;
 * known false negatives are leak phrasings outside LEAK_PATTERNS. Per-run root causes are printed for eyeballing.
 */

// A. the answer is about database connections / the pool.
const POOL = /connection|pool/;

// B. the mechanism: connections acquired and never released.
const LEAK_PATTERNS = [
  /\bleak(s|ed|ing|age)?\b/g, // not "leaky": naming the /orders/leaky endpoint alone is not a diagnosis
  /never releas/g,
  /not releas/g,
  /n't releas/g,
  /without releas/g,
  /fail\w* to releas/g,
  /missing \w* ?release/g,
  /never (returned|freed|given back|checked back)/g,
  /not returned to the pool/g,
  /held (indefinitely|forever)/g,
];

// C. located in order-service (checked in root_cause or summary).
const LOCATION = /order[- ]service|orders\/leaky/;

// D. a negator shortly before a leak phrase cancels it. Whole words only, so "now"/"another" don't count as "no".
const NEGATOR = /\b(not|no|isn't|rather than|ruled out|unlikely)\b/;
const NEGATION_WINDOW = 30;

export interface Grade {
  correct: boolean;
  reasons: { pool: boolean; leak: boolean; location: boolean; negatedLeakPhrases: number };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

export function gradeRootCause(report: Pick<IncidentReport, "root_cause" | "summary">): Grade {
  const cause = normalize(report.root_cause);
  const summary = normalize(report.summary);

  let leak = false;
  let negatedLeakPhrases = 0;
  for (const pattern of LEAK_PATTERNS) {
    for (const m of cause.matchAll(pattern)) {
      const before = cause.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
      // "not releas" / "n't releas" carry their own negation; that is the leak, not a denial of it.
      if (NEGATOR.test(before)) negatedLeakPhrases++;
      else leak = true;
    }
  }

  const pool = POOL.test(cause);
  const location = LOCATION.test(cause) || LOCATION.test(summary);
  return { correct: pool && leak && location, reasons: { pool, leak, location, negatedLeakPhrases } };
}

export function describeGrade(g: Grade): string {
  const flag = (ok: boolean) => (ok ? "✔" : "✘");
  const neg = g.reasons.negatedLeakPhrases ? ` neg×${g.reasons.negatedLeakPhrases}` : "";
  return `pool${flag(g.reasons.pool)} leak${flag(g.reasons.leak)} loc${flag(g.reasons.location)}${neg}`;
}

/** Share of evidence quotes that verified as literal substrings of the text the approach saw. */
export function citationValidity(checks: EvidenceCheck[]): { ok: number; total: number; share: number } {
  const ok = checks.filter((c) => c.ok).length;
  return { ok, total: checks.length, share: checks.length ? ok / checks.length : 0 };
}
