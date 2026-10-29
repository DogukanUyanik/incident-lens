import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunEvent, SCHEMA_VERSION } from "../lib/events.js";
import { isReplayName, listReplays, loadReplay, parseReplay, replayDelays, streamReplay } from "../lib/replay.js";

const ev = (seq: number, t_ms: number | null, body: Record<string, unknown>) =>
  ({ v: SCHEMA_VERSION, run_id: "r", seq, t_ms, ...body }) as RunEvent;

const start = (t: number | null = 0) =>
  ev(0, t, { type: "run_start", scenario_id: "s", alert: "a", model: "m", mode: "live", source: "live" });
const end = (seq: number, t: number | null) =>
  ev(seq, t, { type: "run_end", ok: true, turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, seconds: 1 });
const turn = (seq: number, t: number | null) => ev(seq, t, { type: "turn_start", turn: 1, max_turns: 10 });
const lines = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

test("every replay file shipped in replays/ is valid", async () => {
  const { replays, invalid } = await listReplays();
  assert.deepEqual(invalid, []);
  assert.ok(replays.length >= 4, `expected the 4 reconstructed replays, found ${replays.length}`);
});

test("the schema rejects a wrong version, an unknown type, a missing field and an extra field", () => {
  const ok = start();
  assert.ok(RunEvent.safeParse(ok).success);
  assert.ok(!RunEvent.safeParse({ ...ok, v: 2 }).success);
  assert.ok(!RunEvent.safeParse({ ...ok, type: "launch_missiles" }).success);
  const { alert: _alert, ...noAlert } = ok as Extract<RunEvent, { type: "run_start" }>;
  assert.ok(!RunEvent.safeParse(noAlert).success);
  assert.ok(!RunEvent.safeParse({ ...ok, secret: "x" }).success);
});

test("parseReplay reports the line of the first problem", () => {
  assert.equal(parseReplay(lines([start(), turn(1, 5), end(2, 9)])).length, 3);
  assert.throws(() => parseReplay(""), /empty/);
  assert.throws(() => parseReplay(lines([turn(0, 0), end(1, 1)])), /line 1: the first event must be run_start/);
  assert.throws(() => parseReplay(lines([start(), turn(1, 5)])), /line 2: the last event must be run_end/);
  assert.throws(() => parseReplay(lines([start(), turn(2, 5), end(3, 9)])), /line 2: seq is 2, expected 1/);
  assert.throws(() => parseReplay(`${JSON.stringify(start())}\n{not json`), /line 2: not valid JSON/);
  assert.throws(() => parseReplay(lines([start(), { ...turn(1, 5), run_id: "other" }, end(2, 9)])), /line 2: run_id/);
});

test("replay names allow only plain files in replays/ or replays/live/", () => {
  for (const ok of ["db-pool-exhaustion.reconstructed.ndjson", "live/db-pool-exhaustion-20261029-120000.ndjson"]) {
    assert.ok(isReplayName(ok), ok);
  }
  for (const bad of ["../x.ndjson", "/etc/passwd", "live/../x.ndjson", "x.json", "a/b.ndjson", ".hidden.ndjson", "X.ndjson"]) {
    assert.ok(!isReplayName(bad), bad);
  }
});

test("loadReplay refuses names outside the allow-list, and listReplays skips invalid files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "replays-"));
  mkdirSync(path.join(dir, "live"));
  writeFileSync(path.join(dir, "good.ndjson"), lines([start(), end(1, 1)]));
  writeFileSync(path.join(dir, "live", "bad.ndjson"), "{}");
  writeFileSync(path.join(dir, "notes.txt"), "ignored");
  const { replays, invalid } = await listReplays(dir);
  assert.deepEqual(replays.map((r) => r.name), ["good.ndjson"]);
  assert.deepEqual(invalid, ["live/bad.ndjson"]);
  await assert.rejects(loadReplay("../good.ndjson", dir), /invalid replay name/);
});

test("delays follow recorded gaps, capped, and scaled by speed", () => {
  const events = [start(0), turn(1, 200), turn(2, 5200), end(3, 5300)];
  assert.deepEqual(replayDelays(events), [0, 200, 1500, 100]);
  assert.deepEqual(replayDelays(events, { speed: 2 }), [0, 100, 750, 50]);
});

test("replays without timings use the fixed delay", () => {
  const events = [start(null), turn(1, null), end(2, null)];
  assert.deepEqual(replayDelays(events), [0, 400, 400]);
});

test("streamReplay yields every event in order and stops when aborted", async () => {
  const events = [start(0), turn(1, 10), turn(2, 20), end(3, 30)];
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);
  const got: number[] = [];
  for await (const e of streamReplay(events, { sleep })) got.push(e.seq);
  assert.deepEqual(got, [0, 1, 2, 3]);
  assert.deepEqual(slept, [10, 10, 10]);

  const ctrl = new AbortController();
  const partial: number[] = [];
  for await (const e of streamReplay(events, { sleep, signal: ctrl.signal })) {
    partial.push(e.seq);
    if (e.seq === 1) ctrl.abort();
  }
  assert.deepEqual(partial, [0, 1]);
});
