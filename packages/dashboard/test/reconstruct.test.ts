import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "../lib/events";
import { pickRun, reconstruct, toNdjson, type StoredResult, type StoredRun } from "../lib/reconstruct";
import { parseReplay, REPLAYS_DIR } from "../lib/replay";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(here, "../../../evals/results");
const stored = readdirSync(RESULTS_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(RESULTS_DIR, f), "utf8")) as StoredResult);

const labelOf = (name: string, args: unknown) => `${name} ${JSON.stringify(args)}`;

test("each stored result reconstructs deterministically into the committed replay file", () => {
  assert.ok(stored.length >= 4);
  for (const result of stored) {
    const run = pickRun(result);
    assert.ok(run, result.id);
    const file = readFileSync(path.join(REPLAYS_DIR, `${result.id}.reconstructed.ndjson`), "utf8");
    const alert = (parseReplay(file)[0] as Extract<RunEvent, { type: "run_start" }>).alert;
    assert.equal(toNdjson(reconstruct(result, run, alert)), file, result.id);
    assert.equal(toNdjson(reconstruct(result, run, alert)), toNdjson(reconstruct(result, run, alert)));
  }
});

test("nothing is invented: no text, thinking, tool output or timings; report and checks are the stored ones", () => {
  for (const result of stored) {
    const run = pickRun(result)!;
    const events = reconstruct(result, run, "alert");
    assert.ok(!events.some((e) => ["assistant_text", "thinking", "tool_result"].includes(e.type)), result.id);
    assert.ok(events.every((e) => e.t_ms === null), result.id);
    const start = events[0] as Extract<RunEvent, { type: "run_start" }>;
    assert.equal(start.source, "reconstructed");
    assert.match(start.note ?? "", /not recorded/);

    const final = events.find((e) => e.type === "report_final") as Extract<RunEvent, { type: "report_final" }>;
    assert.deepEqual(final.report, run.report);
    assert.deepEqual(final.checks, run.checks);
    assert.deepEqual(final.usage, run.usage);
    assert.equal(final.turns, run.turns);

    // Every non-null tool argument is exactly one of the cited calls.
    const cited = new Set(run.checks!.flatMap((c) => c.matchedIn));
    for (const e of events) {
      if (e.type === "tool_call" && e.args !== null) assert.ok(cited.has(labelOf(e.name, e.args)), `${result.id}: ${e.name}`);
    }
  }
});

test("turns and tool calls appear only for runs with a trace, matching the trace exactly", () => {
  for (const result of stored) {
    const run = pickRun(result)!;
    const events = reconstruct(result, run, "alert");
    const calls = events.filter((e) => e.type === "tool_call").map((e) => `${(e as { turn: number }).turn}:${(e as { name: string }).name}`);
    const traced = (run.trace ?? []).flatMap((t) =>
      t.blocks.filter((b) => b.type === "tool_use" && b.name !== "submit_report").map((b) => `${t.turn}:${b.name}`)
    );
    assert.deepEqual(calls, traced, result.id);
    assert.equal(events.filter((e) => e.type === "turn_start").length, run.trace?.length ?? 0, result.id);
  }
});

const baseRun = (trace: StoredRun["trace"], matchedIn: string[]): StoredRun => ({
  approach: "agent",
  run: 1,
  ok: true,
  grade: { correct: true },
  report: { summary: "s", root_cause: "r", evidence: [{ source: "x", verbatim_quote: "q" }] },
  checks: [{ source: "x", quote: "q", ok: true, matchedIn, sourceMismatch: false }],
  usage: { input_tokens: 1, output_tokens: 1 },
  models: ["m"],
  seconds: 1,
  turns: trace?.length ?? 1,
  trace,
});
const result = (run: StoredRun): StoredResult => ({ id: "x", startedAt: "t", model: "m", runs: [run] });
const turnWith = (turn: number, ...calls: [string, number][]) => ({
  turn,
  attempt: 1,
  stop_reason: "tool_use",
  output_tokens: 1,
  blocks: calls.map(([name, chars]) => ({ type: "tool_use", name, chars })),
});
const argsOf = (events: RunEvent[]) => events.flatMap((e) => (e.type === "tool_call" ? [e.args] : []));

test("arguments are filled only when name and argument length match exactly one call on both sides", () => {
  const json = '{"container":"a"}';
  const label = `get_container_logs ${json}`;
  const n = json.length;
  // One traced call, one citation of the same length: filled.
  let run = baseRun([turnWith(1, ["get_container_logs", n])], [label]);
  assert.deepEqual(argsOf(reconstruct(result(run), run, "a")), [{ container: "a" }]);
  // Two traced calls of that name and length: ambiguous, both null.
  run = baseRun([turnWith(1, ["get_container_logs", n], ["get_container_logs", n])], [label]);
  assert.deepEqual(argsOf(reconstruct(result(run), run, "a")), [null, null]);
  // Two citations of the same length: ambiguous.
  run = baseRun([turnWith(1, ["get_container_logs", n])], [label, 'get_container_logs {"container":"b"}']);
  assert.deepEqual(argsOf(reconstruct(result(run), run, "a")), [null]);
  // Length differs: not that call.
  run = baseRun([turnWith(1, ["get_container_logs", n + 1])], [label]);
  assert.deepEqual(argsOf(reconstruct(result(run), run, "a")), [null]);
});

test("a retried turn uses its final attempt and emits a retry event", () => {
  const run = baseRun(
    [
      { turn: 1, attempt: 1, stop_reason: "max_tokens", output_tokens: 16000, blocks: [{ type: "text", chars: 9 }] },
      { ...turnWith(1, ["get_cluster_topology", 2]), attempt: 2 },
    ],
    []
  );
  run.turns = 1;
  const types = reconstruct(result(run), run, "a").map((e) => e.type);
  assert.deepEqual(types.slice(0, 4), ["run_start", "turn_start", "retry", "tool_call"]);
});
