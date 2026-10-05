import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { connectTelemetry } from "../packages/agent/src/mcp.js";
import { investigate, MAX_TURNS, type TokenUsage } from "../packages/agent/src/agent.js";
import { SUBMIT_REPORT, type IncidentReport } from "../packages/agent/src/report.js";
import type { EvidenceCheck } from "../packages/agent/src/verifier.js";
import { MODEL, runBaseline } from "./baseline.js";
import { citationValidity, describeGrade, gradeRootCause, type Grade } from "./grader.js";

// Same as DEFAULT_ALERT in packages/agent/src/index.ts (not importable: that file runs the agent on import).
const ALERT = "the gateway is returning 504 Gateway Timeout errors on GET /orders";
const GATEWAY_ORDERS_URL = "http://localhost:8080/orders";
const RESULTS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "results.md");

type Approach = "agent" | "baseline";

interface RunRecord {
  approach: Approach;
  run: number;
  ok: boolean;
  report?: IncidentReport;
  checks?: EvidenceCheck[];
  failure?: string;
  grade?: Grade;
  usage: TokenUsage;
  models: string[];
  seconds: number;
  turns?: number;
  truncated?: string[];
}

function parseRuns(): number {
  const i = process.argv.indexOf("--runs");
  const raw = i >= 0 ? process.argv[i + 1] : process.env.BENCH_RUNS;
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`invalid run count "${raw}" (use --runs N or BENCH_RUNS=N with N >= 1)`);
    process.exit(2);
  }
  return n;
}

/** The benchmark is meaningless unless the Phase 1 failure is active. Never triggers or resets it. */
async function checkPrecondition(): Promise<void> {
  const start = "cd sandbox && docker compose up -d --build, then ./sandbox/chaos/scenario-db-exhaustion.sh";
  let status: number;
  try {
    const res = await fetch(GATEWAY_ORDERS_URL, { signal: AbortSignal.timeout(8000) });
    status = res.status;
  } catch (err) {
    const cause = err instanceof Error && err.cause ? ` (${String(err.cause)})` : "";
    console.error(`ABORT: sandbox not reachable at ${GATEWAY_ORDERS_URL}: ${String(err)}${cause}`);
    console.error(`Start it and trigger the failure: ${start}`);
    process.exit(2);
  }
  if (status !== 504) {
    console.error(`ABORT: failure not active: GET ${GATEWAY_ORDERS_URL} returned ${status}, expected 504.`);
    console.error("Trigger it with: ./sandbox/chaos/scenario-db-exhaustion.sh");
    process.exit(2);
  }
  console.log(`precondition ok: GET ${GATEWAY_ORDERS_URL} -> 504`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; seconds: number }> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { value, seconds: (performance.now() - t0) / 1000 };
  } catch (error) {
    return { error, seconds: (performance.now() - t0) / 1000 };
  }
}

const ZERO: TokenUsage = { input_tokens: 0, output_tokens: 0 };
const errorText = (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`;

// ── formatting ───────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmtInt = (n: number) => (Number.isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US"));
const fmtPct = (x: number) => `${Math.round(x * 100)}%`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function summaryRows(runs: RunRecord[]): Record<string, string> {
  const n = runs.length;
  const correct = runs.filter((r) => r.grade?.correct).length;
  const failed = runs.filter((r) => !r.ok).length;
  const inTok = mean(runs.map((r) => r.usage.input_tokens));
  const outTok = mean(runs.map((r) => r.usage.output_tokens));
  const withReport = runs.filter((r) => r.report && r.checks);
  const validity = mean(withReport.map((r) => citationValidity(r.checks!).share));
  const isAgent = runs[0]?.approach === "agent";
  const validityText = withReport.length
    ? `${fmtPct(validity)} (${withReport.length}/${n} runs had a report)${isAgent ? " — 100% by construction: the agent's verifier rejects unverified reports" : ""}`
    : `— (0/${n} runs had a report)`;
  return {
    accuracy: `${correct}/${n}`,
    tokens: `${fmtInt(inTok + outTok)} (in ${fmtInt(inTok)} / out ${fmtInt(outTok)})`,
    time: `${mean(runs.map((r) => r.seconds)).toFixed(1)}s`,
    citations: validityText,
    failed: `${failed}/${n}`,
    turns: isAgent ? mean(runs.map((r) => r.turns ?? 0)).toFixed(1) : "1 call",
  };
}

function render(runs: RunRecord[], n: number, startedAt: Date): string {
  const agent = summaryRows(runs.filter((r) => r.approach === "agent"));
  const baseline = summaryRows(runs.filter((r) => r.approach === "baseline"));
  const served = [...new Set(runs.flatMap((r) => r.models))];
  const truncated = [...new Set(runs.flatMap((r) => r.truncated ?? []))].sort();

  const lines: string[] = [];
  lines.push("# IncidentLens benchmark — agent vs naive baseline", "");
  lines.push(`- **Date:** ${startedAt.toISOString()}`);
  lines.push(`- **Model requested:** \`${MODEL}\`; **served:** ${served.map((m) => `\`${m}\``).join(", ") || "—"}`);
  lines.push(`- **Runs per approach (N):** ${n}`);
  lines.push(`- **Alert:** "${ALERT}"`);
  lines.push("- **ONE scenario (db pool exhaustion / order-service connection leak); not a general result.**");
  lines.push(
    "- Both approaches see the same 4000-char-per-call log window (the MCP server's cap). In the baseline's " +
      `collections, the cap truncated the logs of: ${truncated.join(", ") || "none"}. The baseline gets every ` +
      "container's logs (tail=1000) and stats in one prompt; the agent fetches what it chooses via tools."
  );
  lines.push(
    "- Grading is a code-based keyword heuristic (`evals/grader.ts`): correct = mentions the pool/connections, " +
      "a non-negated leak / never-released mechanism, and order-service. Check the root causes below by eye."
  );
  lines.push("");
  lines.push("## Summary", "");
  lines.push("| Metric | Agent | Baseline |", "|---|---|---|");
  lines.push(`| Accuracy | ${agent.accuracy} | ${baseline.accuracy} |`);
  lines.push(`| Mean tokens (input + output) | ${agent.tokens} | ${baseline.tokens} |`);
  lines.push(`| Mean wall-clock time | ${agent.time} | ${baseline.time} |`);
  lines.push(`| Citation validity (mean) | ${agent.citations} | ${baseline.citations} |`);
  lines.push(`| Failed runs (no usable report) | ${agent.failed} | ${baseline.failed} |`);
  lines.push(`| Mean turns | ${agent.turns} | ${baseline.turns} |`);
  lines.push("");
  lines.push("## Per run", "");
  lines.push("| Approach | Run | Verdict | Grader signals | Tokens | Time | Citations | Root cause / failure |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of runs) {
    const verdict = !r.ok ? "FAILED" : r.grade?.correct ? "correct" : "wrong";
    const cv = r.checks ? citationValidity(r.checks) : undefined;
    const text = r.ok
      ? r.report!.root_cause
      : `**${r.failure ?? "failed"}**${r.report ? ` — root_cause: ${r.report.root_cause}` : ""}`;
    lines.push(
      `| ${r.approach} | ${r.run} | ${verdict} | ${r.grade ? describeGrade(r.grade) : "—"} | ` +
        `${fmtInt(r.usage.input_tokens + r.usage.output_tokens)} | ${r.seconds.toFixed(1)}s | ` +
        `${cv ? `${cv.ok}/${cv.total}` : "—"} | ${cell(text)} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────

const n = parseRuns();
await checkPrecondition();

const telemetry = await connectTelemetry();
const runs: RunRecord[] = [];
const startedAt = new Date();
let exitCode = 0;
try {
  if (telemetry.tools.some((t) => t.name === SUBMIT_REPORT)) {
    throw new Error(`MCP server exposes a tool named "${SUBMIT_REPORT}", which clashes with the agent's own tool`);
  }
  console.log(`model: ${MODEL}, runs per approach: ${n}, agent turn budget: ${MAX_TURNS}`);

  for (let i = 1; i <= n; i++) {
    console.log(`\n=================== agent run ${i}/${n} ===================`);
    const a = await timed(() => investigate(ALERT, telemetry));
    const ar = a.value;
    runs.push({
      approach: "agent",
      run: i,
      ok: ar?.ok ?? false,
      report: ar?.ok ? ar.report : undefined,
      checks: ar?.ok ? ar.checks : undefined,
      failure: ar ? ar.failure : errorText(a.error),
      grade: ar?.ok && ar.report ? gradeRootCause(ar.report) : undefined,
      usage: ar?.usage ?? ZERO,
      models: ar?.models ?? [],
      seconds: a.seconds,
      turns: ar?.turns,
    });

    console.log(`\n=================== baseline run ${i}/${n} ===================`);
    const b = await timed(() => runBaseline(ALERT, telemetry));
    const br = b.value;
    if (br) console.log(`  telemetry in prompt: ${br.telemetryChars} chars`);
    runs.push({
      approach: "baseline",
      run: i,
      ok: br?.ok ?? false,
      report: br?.report,
      checks: br?.checks,
      failure: br ? br.failure : errorText(b.error),
      grade: br?.ok && br.report ? gradeRootCause(br.report) : undefined,
      usage: br?.usage ?? ZERO,
      models: br?.models ?? [],
      seconds: b.seconds,
      truncated: br?.truncated,
    });

    const last = runs.slice(-2);
    for (const r of last) {
      const verdict = !r.ok ? `FAILED (${r.failure})` : r.grade!.correct ? "correct" : "wrong";
      console.log(`  ${r.approach} #${r.run}: ${verdict}`);
    }
  }
} catch (err) {
  console.error(`benchmark error: ${errorText(err)}`);
  exitCode = 1;
} finally {
  await telemetry.close();
}

if (runs.length > 0) {
  const md = render(runs, n, startedAt);
  console.log(`\n${md}`);
  await writeFile(RESULTS_PATH, md);
  console.log(`written to ${RESULTS_PATH}`);
}
process.exit(exitCode);
