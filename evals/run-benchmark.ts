import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { connectTelemetry, type TelemetryClient } from "../packages/agent/src/mcp.js";
import { investigate, MAX_TURNS, type TokenUsage } from "../packages/agent/src/agent.js";
import { SUBMIT_REPORT, type IncidentReport } from "../packages/agent/src/report.js";
import type { EvidenceCheck } from "../packages/agent/src/verifier.js";
import { MODEL, runBaseline } from "./baseline.js";
import { citationValidity, describeGrade, gradeRootCause, type Grade } from "./grader.js";
import { checkPrecondition, loadScenarios, REPO_ROOT, type Scenario } from "./scenarios.js";

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(EVALS_DIR, "results");
const RESULTS_MD = path.join(EVALS_DIR, "results.md");

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

/** One scenario's results, persisted as evals/results/<id>.json. */
interface ScenarioResult {
  id: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  n: number;
  skipped?: string;
  runs: RunRecord[];
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const scenarios = loadScenarios();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usageAndExit(message?: string): never {
  if (message) console.error(message);
  console.error(
    "usage: npm run bench -- --scenario <id> [--runs N]     (benchmark one scenario; checks its precondition only)\n" +
      "       npm run bench -- --all [--runs N]               (opt-in: reset + trigger + run every scenario, then reset)\n" +
      `scenarios: ${scenarios.map((s) => s.id).join(", ")}`
  );
  process.exit(2);
}

function parseRuns(): number {
  const raw = argValue("--runs") ?? process.env.BENCH_RUNS;
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) usageAndExit(`invalid run count "${raw}" (N >= 1)`);
  return n;
}

const all = process.argv.includes("--all");
const scenarioId = argValue("--scenario");
if (all === Boolean(scenarioId)) usageAndExit("pass exactly one of --scenario <id> or --all");
const selected = all ? scenarios : scenarios.filter((s) => s.id === scenarioId);
if (selected.length === 0) usageAndExit(`unknown scenario "${scenarioId}"`);
const n = parseRuns();

// ── sandbox orchestration (only with --all) ──────────────────────────────────

function runScript(script: string): boolean {
  console.log(`\n$ ${script}`);
  const res = spawnSync("bash", [script], { cwd: REPO_ROOT, stdio: "inherit" });
  return res.status === 0;
}

// ── runs ─────────────────────────────────────────────────────────────────────

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

async function benchmarkScenario(s: Scenario, telemetry: TelemetryClient): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: s.id, startedAt: new Date().toISOString(), finishedAt: "", model: MODEL, n, runs: [] };

  for (let i = 1; i <= n; i++) {
    console.log(`\n=================== [${s.id}] agent run ${i}/${n} ===================`);
    const a = await timed(() => investigate(s.alert, telemetry));
    const ar = a.value;
    result.runs.push({
      approach: "agent",
      run: i,
      ok: ar?.ok ?? false,
      report: ar?.ok ? ar.report : undefined,
      checks: ar?.ok ? ar.checks : undefined,
      failure: ar ? ar.failure : errorText(a.error),
      grade: ar?.ok && ar.report ? gradeRootCause(ar.report, s.grading) : undefined,
      usage: ar?.usage ?? ZERO,
      models: ar?.models ?? [],
      seconds: a.seconds,
      turns: ar?.turns,
    });

    console.log(`\n=================== [${s.id}] baseline run ${i}/${n} ===================`);
    const b = await timed(() => runBaseline(s.alert, telemetry));
    const br = b.value;
    if (br) console.log(`  telemetry in prompt: ${br.telemetryChars} chars`);
    result.runs.push({
      approach: "baseline",
      run: i,
      ok: br?.ok ?? false,
      report: br?.report,
      checks: br?.checks,
      failure: br ? br.failure : errorText(b.error),
      grade: br?.ok && br.report ? gradeRootCause(br.report, s.grading) : undefined,
      usage: br?.usage ?? ZERO,
      models: br?.models ?? [],
      seconds: b.seconds,
      truncated: br?.truncated,
    });

    for (const r of result.runs.slice(-2)) {
      const verdict = !r.ok ? `FAILED (${r.failure})` : r.grade!.correct ? "correct" : "wrong";
      console.log(`  ${r.approach} #${r.run}: ${verdict}`);
    }
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

// ── rendering ────────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmtInt = (x: number) => (Number.isNaN(x) ? "—" : Math.round(x).toLocaleString("en-US"));
const fmtPct = (x: number) => `${Math.round(x * 100)}%`;
const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function summarize(runs: RunRecord[], approach: Approach) {
  const rs = runs.filter((r) => r.approach === approach);
  const withReport = rs.filter((r) => r.report && r.checks);
  const validity = mean(withReport.map((r) => citationValidity(r.checks!).share));
  const inTok = mean(rs.map((r) => r.usage.input_tokens));
  const outTok = mean(rs.map((r) => r.usage.output_tokens));
  return {
    n: rs.length,
    correct: rs.filter((r) => r.grade?.correct).length,
    accuracy: `${rs.filter((r) => r.grade?.correct).length}/${rs.length}`,
    tokens: `${fmtInt(inTok + outTok)} (in ${fmtInt(inTok)} / out ${fmtInt(outTok)})`,
    time: rs.length ? `${mean(rs.map((r) => r.seconds)).toFixed(1)}s` : "—",
    citations: withReport.length
      ? `${fmtPct(validity)} (${withReport.length}/${rs.length} runs had a report)${approach === "agent" ? " — by construction" : ""}`
      : `— (0/${rs.length} runs had a report)`,
    failed: `${rs.filter((r) => !r.ok).length}/${rs.length}`,
    turns: approach === "agent" ? (rs.length ? mean(rs.map((r) => r.turns ?? 0)).toFixed(1) : "—") : "1 call",
  };
}

function renderScenario(s: Scenario, res: ScenarioResult | undefined): string[] {
  const lines = [`## ${s.title} (\`${s.id}\`)`, ""];
  if (!res) return [...lines, "_Not run yet._", ""];
  lines.push(`- **Run:** ${res.startedAt} → ${res.finishedAt || "—"}, N=${res.n}, model \`${res.model}\``);
  lines.push(`- **Alert:** "${s.alert}"`);
  lines.push(`- **Ground truth:** ${s.ground_truth}`);
  if (res.skipped) return [...lines, "", `**SKIPPED (setup failed):** ${res.skipped}`, ""];

  const truncated = [...new Set(res.runs.flatMap((r) => r.truncated ?? []))].sort();
  lines.push(`- **Log cap:** the 4000-char cap truncated the logs of: ${truncated.join(", ") || "none"} (baseline collections).`);
  lines.push("");
  const a = summarize(res.runs, "agent");
  const b = summarize(res.runs, "baseline");
  lines.push("| Metric | Agent | Baseline |", "|---|---|---|");
  lines.push(`| Accuracy | ${a.accuracy} | ${b.accuracy} |`);
  lines.push(`| Mean tokens (input + output) | ${a.tokens} | ${b.tokens} |`);
  lines.push(`| Mean wall-clock time | ${a.time} | ${b.time} |`);
  lines.push(`| Citation validity (mean) | ${a.citations} | ${b.citations} |`);
  lines.push(`| Failed runs (no usable report) | ${a.failed} | ${b.failed} |`);
  lines.push(`| Mean turns | ${a.turns} | ${b.turns} |`);
  lines.push("");
  lines.push("| Approach | Run | Verdict | Grader signals | Tokens | Time | Citations | Root cause / failure |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of res.runs) {
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
  return lines;
}

async function loadResults(): Promise<Map<string, ScenarioResult>> {
  const out = new Map<string, ScenarioResult>();
  const files = await readdir(RESULTS_DIR).catch(() => [] as string[]);
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const r = JSON.parse(await readFile(path.join(RESULTS_DIR, f), "utf8")) as ScenarioResult;
    out.set(r.id, r);
  }
  return out;
}

function render(results: Map<string, ScenarioResult>): string {
  const served = [...new Set([...results.values()].flatMap((r) => r.runs.flatMap((x) => x.models)))];
  const lines: string[] = ["# IncidentLens benchmark — agent vs naive baseline", ""];
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push(`- **Model requested:** \`${MODEL}\`; **served:** ${served.map((m) => `\`${m}\``).join(", ") || "—"}`);
  lines.push(
    `- **${scenarios.length} self-authored scenarios** (written by the author of the agent); not a general result. ` +
      "Each scenario was run separately; its run date is in its section."
  );
  lines.push(
    "- Both approaches reach the same sources through the same MCP tools (logs, stats, topology, deploy history), " +
      "each capped at 4000 chars per call. The baseline gets all of it in one prompt (every container's logs at " +
      "tail=1000 and stats, the topology, and every commit of every deploy history); the agent fetches what it chooses."
  );
  lines.push(
    "- `memory-leak-oom`: Docker clears OOMKilled/ExitCode when the restart policy restarts a container, so the OOM " +
      "is only inferable (restart count, uptime, memory vs limit, repeated startup lines), not shown directly."
  );
  lines.push(
    "- `db-pool-exhaustion` uses the same grading criteria as Phase 4, but its inputs differ: both approaches now also " +
      "see topology and deploy history, and the reset clears gateway/order-service logs (Phase 4 runs saw stale lines)."
  );
  lines.push(
    "- Grading is a code-based keyword heuristic per scenario (`evals/scenarios.json` → `grading`): correct iff every " +
      "keyword group matches, with whole-word negation. Check the root causes below by eye."
  );
  lines.push("", "## Combined summary", "");
  lines.push("| Scenario | Approach | Accuracy | Mean tokens | Mean time | Citation validity | Failed | Mean turns |");
  lines.push("|---|---|---|---|---|---|---|---|");
  const totals = { agent: { correct: 0, n: 0 }, baseline: { correct: 0, n: 0 } };
  for (const s of scenarios) {
    const res = results.get(s.id);
    if (!res || res.skipped) {
      lines.push(`| ${s.id} | — | ${res?.skipped ? "SKIPPED (setup failed)" : "not run"} | | | | | |`);
      continue;
    }
    for (const approach of ["agent", "baseline"] as const) {
      const x = summarize(res.runs, approach);
      totals[approach].correct += x.correct;
      totals[approach].n += x.n;
      lines.push(`| ${s.id} | ${approach} | ${x.accuracy} | ${x.tokens} | ${x.time} | ${x.citations} | ${x.failed} | ${x.turns} |`);
    }
  }
  for (const approach of ["agent", "baseline"] as const) {
    lines.push(`| **all run scenarios** | ${approach} | **${totals[approach].correct}/${totals[approach].n}** | | | | | |`);
  }
  lines.push("");
  for (const s of scenarios) lines.push(...renderScenario(s, results.get(s.id)));
  return lines.join("\n");
}

async function save(result: ScenarioResult) {
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(path.join(RESULTS_DIR, `${result.id}.json`), JSON.stringify(result, null, 2));
}

// ── main ─────────────────────────────────────────────────────────────────────

if (!all) {
  // Phase 4 rule: verify the failure is active, never change the sandbox.
  const s = selected[0];
  const failures = await checkPrecondition(s);
  if (failures.length > 0) {
    console.error(`ABORT: scenario "${s.id}" is not active: ${s.precondition.description}`);
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error(`Reset and trigger it with: ${s.reset} && ${s.trigger}`);
    process.exit(2);
  }
  console.log(`precondition ok for ${s.id}: ${s.precondition.description}`);
} else {
  console.log("--all: this will reset and trigger each scenario in the sandbox, and reset it again at the end.");
}

const telemetry = await connectTelemetry();
let exitCode = 0;
try {
  if (telemetry.tools.some((t) => t.name === SUBMIT_REPORT)) {
    throw new Error(`MCP server exposes a tool named "${SUBMIT_REPORT}", which clashes with the agent's own tool`);
  }
  console.log(`model: ${MODEL}, runs per approach: ${n}, agent turn budget: ${MAX_TURNS}`);
  console.log(`tools from MCP server: ${telemetry.tools.map((t) => t.name).join(", ")}`);

  for (const s of selected) {
    if (all) {
      console.log(`\n########## ${s.id}: reset → trigger → precondition ##########`);
      const setupOk = runScript(s.reset) && runScript(s.trigger);
      const failures = setupOk ? await checkPrecondition(s) : ["reset or trigger script failed"];
      if (failures.length > 0) {
        console.error(`SKIPPED ${s.id}: ${failures.join("; ")}`);
        const now = new Date().toISOString();
        await save({ id: s.id, startedAt: now, finishedAt: now, model: MODEL, n, skipped: failures.join("; "), runs: [] });
        exitCode = 1;
        continue;
      }
    }
    await save(await benchmarkScenario(s, telemetry));
  }
} catch (err) {
  console.error(`benchmark error: ${errorText(err)}`);
  exitCode = 1;
} finally {
  await telemetry.close();
  if (all && !runScript(scenarios[0].reset)) exitCode = 1;
}

const md = render(await loadResults());
console.log(`\n${md}`);
await writeFile(RESULTS_MD, md);
console.log(`written to ${RESULTS_MD}`);
process.exit(exitCode);
