import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { currentActivity } from "../lib/activity";
import { getConfig, postLive, postScript } from "../lib/handlers";
import { startLive } from "../lib/live";
import { parseReplay } from "../lib/replay";
import { fakeLive, fakeScripts, frames, req, testDeps, tick } from "./http";

const T0 = Date.parse("2026-10-29T12:00:00Z");
const liveReq = (scenario_id = "db-pool-exhaustion") => req("POST", "/api/runs/live", { body: { scenario_id } });

test("live is off unless ALLOW_LIVE is exactly 'true'", async () => {
  for (const ALLOW_LIVE of [undefined, "", "false", "1", "TRUE", "yes"]) {
    const live = fakeLive();
    const deps = testDeps({ startLive: live.startLive, env: ALLOW_LIVE === undefined ? {} : { ALLOW_LIVE } });
    const res = await postLive(liveReq(), deps);
    assert.equal(res.status, 403, String(ALLOW_LIVE));
    assert.deepEqual(live.started, []);
    assert.equal((await (await getConfig(req("GET", "/api/config"), deps)).json()).live_enabled, false);
  }
});

test("one live start per 60s, and the limit survives a server restart", async () => {
  const live = fakeLive();
  let now = T0;
  const deps = testDeps({ startLive: live.startLive, env: { ALLOW_LIVE: "true" }, now: () => now });

  const first = await postLive(liveReq(), deps);
  assert.equal(first.status, 200);
  live.end();
  const got = await frames(first);
  assert.deepEqual(got.map((f) => f.event), ["live_start", "run_event", "run_event"]);
  await tick();

  now = T0 + 30_000;
  const second = await postLive(liveReq(), deps);
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "30");

  // "Restart": fresh dependencies, same state file on disk.
  const restarted = testDeps({ startLive: live.startLive, env: { ALLOW_LIVE: "true" }, now: () => now, stateFile: deps.stateFile });
  assert.equal((await postLive(liveReq(), restarted)).status, 429);
  assert.equal((await (await getConfig(req("GET", "/api/config"), restarted)).json()).live_retry_after_s, 30);

  now = T0 + 60_000;
  const third = await postLive(liveReq(), restarted);
  assert.equal(third.status, 200);
  live.end();
  await frames(third);
  await tick();
  assert.deepEqual(live.started, ["db-pool-exhaustion", "db-pool-exhaustion"]);
});

test("refused live requests never use up the slot", async () => {
  const live = fakeLive();
  const deps = testDeps({ startLive: live.startLive, env: { ALLOW_LIVE: "true" } });
  for (const body of [{ scenario_id: "nope" }, { scenario_id: "upstream-fixture" }, { wrong: 1 }, "not json", "x".repeat(2000)]) {
    const res = await postLive(req("POST", "/api/runs/live", { body }), deps);
    assert.ok([400, 404].includes(res.status), JSON.stringify(body).slice(0, 40));
  }
  assert.throws(() => readFileSync(deps.stateFile));
  assert.equal((await postLive(liveReq(), deps)).status, 200);
  live.end();
  await tick();
});

test("no trigger or reset while a live run is in progress, even after the browser disconnects", async () => {
  const live = fakeLive();
  const scripts = fakeScripts();
  const deps = testDeps({ startLive: live.startLive, runScript: scripts.runner, env: { ALLOW_LIVE: "true" } });
  const res = await postLive(liveReq(), deps);
  assert.equal(res.status, 200);
  await res.body!.cancel(); // tab closed: the paid run still goes on to the end
  await tick();
  assert.equal(currentActivity()?.kind, "live");
  for (const kind of ["trigger", "reset"] as const) {
    assert.equal((await postScript(req("POST", "/x"), "corrupt-deploy", kind, deps)).status, 409, kind);
  }
  assert.deepEqual(scripts.ran, []);
  live.end();
  await tick();
  assert.equal(currentActivity(), null);
});

// ── the real runner, in stub mode ───────────────────────────────────────────

test("end to end with the real runner (AGENT_STUB=1): events stream and the replay file is saved", { timeout: 60_000 }, async () => {
  const replaysDir = mkdtempSync(path.join(tmpdir(), "replays-"));
  const stubSpawn = (scenarioId: string, runId: string) =>
    spawn(path.join("node_modules", ".bin", "tsx"), ["runner/run-agent.ts", scenarioId, runId], {
      env: { NODE_ENV: "test", PATH: process.env.PATH, AGENT_STUB: "1", STUB_DELAY_MS: "50", ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const run = startLive("db-pool-exhaustion", { spawn: stubSpawn, replaysDir, now: new Date(T0), log: () => {} });
  const streamed = [];
  for await (const e of run.events) streamed.push(e);
  await run.done;

  assert.equal(run.file, "live/db-pool-exhaustion-20261029-120000.ndjson");
  const saved = readFileSync(path.join(replaysDir, run.file), "utf8");
  assert.deepEqual(parseReplay(saved), streamed);
  assert.deepEqual(streamed.map((e) => e.type), [
    "run_start",
    "turn_start",
    "assistant_text",
    "tool_call",
    "tool_result",
    "turn_start",
    "report_submitted",
    "verification",
    "report_final",
    "run_end",
  ]);
  const start = streamed[0];
  assert.ok(start.type === "run_start" && start.source === "live" && start.model === "stub-model");
  assert.match(start.note ?? "", /Stub run/);
  assert.ok(!saved.includes("sk-ant"), "no credential in the saved replay");
});

test("a runner that dies mid-run still leaves a complete replay (error + run_end added)", { timeout: 30_000 }, async () => {
  const replaysDir = mkdtempSync(path.join(tmpdir(), "replays-"));
  const dying = (scenarioId: string, runId: string) => {
    const start = { v: 1, run_id: runId, seq: 0, t_ms: 0, type: "run_start", scenario_id: scenarioId, alert: "a", model: "m", mode: "live", source: "live" };
    const script = `console.log(${JSON.stringify(JSON.stringify(start))}); process.exit(3);`;
    return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  };
  const run = startLive("corrupt-deploy", { spawn: dying, replaysDir, now: new Date(T0), log: () => {} });
  const streamed = [];
  for await (const e of run.events) streamed.push(e);
  const events = parseReplay(readFileSync(path.join(replaysDir, run.file), "utf8"));
  assert.deepEqual(events.map((e) => e.type), ["run_start", "error", "run_end"]);
  const err = events[1];
  assert.ok(err.type === "error" && err.stage === "runner");
  assert.match(err.message, /exited \(code 3\) before the run ended/);
  assert.deepEqual(streamed, events);
});

test("a runner that prints garbage or another run's events can't corrupt the replay", { timeout: 30_000 }, async () => {
  const replaysDir = mkdtempSync(path.join(tmpdir(), "replays-"));
  const noisy = (scenarioId: string, runId: string) => {
    const ev = (o: object) => JSON.stringify({ v: 1, run_id: runId, t_ms: 0, ...o });
    const lines = [
      "not json",
      ev({ seq: 0, type: "run_start", scenario_id: scenarioId, alert: "a", model: "m", mode: "live", source: "live" }),
      JSON.stringify({ v: 1, run_id: "someone-else", seq: 1, t_ms: 0, type: "turn_start", turn: 1, max_turns: 10 }),
      ev({ seq: 5, type: "turn_start", turn: 1, max_turns: 10 }),
      ev({ seq: 1, type: "turn_start", turn: 1, max_turns: 10, extra: "field" }),
      ev({ seq: 1, type: "run_end", ok: true, turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, seconds: 1 }),
    ];
    return spawn(process.execPath, ["-e", lines.map((l) => `console.log(${JSON.stringify(l)});`).join("")], { stdio: ["ignore", "pipe", "pipe"] });
  };
  const run = startLive("corrupt-deploy", { spawn: noisy, replaysDir, now: new Date(T0), log: () => {} });
  for await (const _ of run.events) {
    // drain
  }
  const events = parseReplay(readFileSync(path.join(replaysDir, run.file), "utf8"));
  assert.deepEqual(events.map((e) => e.type), ["run_start", "run_end"]);
});
