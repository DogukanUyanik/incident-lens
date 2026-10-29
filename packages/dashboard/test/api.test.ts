import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { currentActivity } from "../lib/activity";
import { getConfig, getReplay, getScenarios, postLive, postScript } from "../lib/handlers";
import { REPO_ROOT } from "../lib/paths";
import { fakeLive, fakeScripts, frames, ORIGIN, req, testDeps, tick } from "./http";

const SCENARIOS = JSON.parse(readFileSync(path.join(REPO_ROOT, "evals", "scenarios.json"), "utf8")) as {
  scenarios: { id: string; trigger: string; reset: string; fixture?: boolean }[];
};
const BENCHMARK_IDS = SCENARIOS.scenarios.filter((s) => !s.fixture).map((s) => s.id);
const chaos = (script: string) => path.join(REPO_ROOT, script);

// ── allow-list ───────────────────────────────────────────────────────────────

test("GET /api/scenarios lists exactly the non-fixture scenarios, with their replays", async () => {
  const body = await (await getScenarios(req("GET", "/api/scenarios"), testDeps())).json();
  assert.deepEqual(body.scenarios.map((s: { id: string }) => s.id), BENCHMARK_IDS);
  assert.ok(!body.scenarios.some((s: { id: string }) => s.id === "upstream-fixture"));
  for (const s of body.scenarios) {
    assert.deepEqual(Object.keys(s).sort(), ["alert", "id", "replays", "title"]);
    assert.ok(s.replays.some((r: { source: string }) => r.source === "reconstructed"), s.id);
  }
});

test("trigger and reset run exactly the script scenarios.json names for that id", async () => {
  for (const s of SCENARIOS.scenarios.filter((x) => !x.fixture)) {
    for (const kind of ["trigger", "reset"] as const) {
      const scripts = fakeScripts();
      const res = await postScript(req("POST", `/api/scenarios/${s.id}/${kind}`), s.id, kind, testDeps({ runScript: scripts.runner }));
      assert.equal(res.status, 200, `${s.id} ${kind}`);
      scripts.finish();
      const got = await frames(res);
      assert.deepEqual(scripts.ran, [chaos(s[kind])], `${s.id} ${kind}`);
      assert.deepEqual(got.map((f) => f.event), ["script_start", "script_line", "script_end"]);
      assert.deepEqual(got[0].data, { scenario_id: s.id, kind });
    }
  }
});

test("unknown, fixture and malformed ids are refused before anything runs", async () => {
  const scripts = fakeScripts();
  const deps = testDeps({ runScript: scripts.runner });
  const cases: [string, number][] = [
    ["no-such-scenario", 404],
    ["upstream-fixture", 404],
    ["../../etc/passwd", 400],
    ["Db-Pool", 400],
    ["", 400],
    ["a".repeat(65), 400],
    ["db-pool-exhaustion;rm", 400],
  ];
  for (const [id, status] of cases) {
    const res = await postScript(req("POST", "/api/scenarios/x/trigger"), id, "trigger", deps);
    assert.equal(res.status, status, JSON.stringify(id));
  }
  assert.deepEqual(scripts.ran, []);
});

test("script entries that are not a plain sandbox/chaos/*.sh path are refused", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scenarios-"));
  const bad = [
    "./sandbox/chaos/../../evals/run.sh",
    "/bin/sh",
    "./sandbox/chaos/reset.sh; rm -rf /",
    "sandbox/chaos/reset.sh",
    "./sandbox/chaos/sub/reset.sh",
    "./sandbox/chaos/reset.py",
    "./sandbox/chaos/does-not-exist.sh",
  ];
  const scripts = fakeScripts();
  for (const trigger of bad) {
    const file = path.join(dir, "scenarios.json");
    writeFileSync(file, JSON.stringify({ version: 1, scenarios: [{ id: "x", title: "x", alert: "x", trigger, reset: trigger }] }));
    const res = await postScript(req("POST", "/api/scenarios/x/trigger"), "x", "trigger", testDeps({ runScript: scripts.runner, scenariosFile: file }));
    assert.equal(res.status, 500, trigger);
    const body = await res.json();
    assert.equal(body.error, "scenario script is not allowed", trigger);
    assert.ok(!JSON.stringify(body).includes("sandbox"), "the refusal must not echo the path");
  }
  assert.deepEqual(scripts.ran, []);
});

// ── one thing at a time ──────────────────────────────────────────────────────

test("only one script at a time, and no live run while a script runs", async () => {
  const scripts = fakeScripts();
  const live = fakeLive();
  const deps = testDeps({ runScript: scripts.runner, startLive: live.startLive, env: { ALLOW_LIVE: "true" } });

  const first = await postScript(req("POST", "/api/scenarios/db-pool-exhaustion/trigger"), "db-pool-exhaustion", "trigger", deps);
  assert.equal(first.status, 200);
  await tick();
  assert.deepEqual(currentActivity() && [currentActivity()!.kind, currentActivity()!.scenario_id], ["trigger", "db-pool-exhaustion"]);

  const second = await postScript(req("POST", "/api/scenarios/corrupt-deploy/reset"), "corrupt-deploy", "reset", deps);
  assert.equal(second.status, 409);
  assert.deepEqual((await second.json()).busy.kind, "trigger");
  const liveRes = await postLive(req("POST", "/api/runs/live", { body: { scenario_id: "corrupt-deploy" } }), deps);
  assert.equal(liveRes.status, 409);
  assert.deepEqual(live.started, []);

  scripts.finish();
  await frames(first);
  await tick();
  assert.equal(currentActivity(), null);
  const third = await postScript(req("POST", "/api/scenarios/corrupt-deploy/reset"), "corrupt-deploy", "reset", deps);
  assert.equal(third.status, 200);
  scripts.finish();
  await frames(third);
  await tick();
});

test("a script keeps the lock until it finishes, even if the browser disconnects", async () => {
  const scripts = fakeScripts();
  const deps = testDeps({ runScript: scripts.runner });
  const res = await postScript(req("POST", "/api/scenarios/db-pool-exhaustion/reset"), "db-pool-exhaustion", "reset", deps);
  await res.body!.cancel(); // the tab was closed
  await tick();
  assert.equal(currentActivity()?.kind, "reset", "a half-run reset must not free the sandbox for others");
  scripts.finish();
  await tick();
  assert.equal(currentActivity(), null);
});

// ── Host and Origin ──────────────────────────────────────────────────────────

test("every route refuses a non-loopback Host (DNS rebinding)", async () => {
  const deps = testDeps();
  for (const host of ["evil.example", "evil.example:3000", "192.168.1.5:3000", "127.0.0.1.evil.example:3000"]) {
    const o = `http://${host}`;
    const responses = [
      await getScenarios(req("GET", "/api/scenarios", { host }), deps),
      await getConfig(req("GET", "/api/config", { host }), deps),
      await getReplay(req("GET", "/api/runs/replay?name=db-pool-exhaustion.reconstructed.ndjson", { host }), deps),
      await postScript(req("POST", "/x", { host, origin: o }), "db-pool-exhaustion", "trigger", deps),
      await postScript(req("POST", "/x", { host, origin: o }), "db-pool-exhaustion", "reset", deps),
      await postLive(req("POST", "/x", { host, origin: o, body: { scenario_id: "db-pool-exhaustion" } }), deps),
    ];
    for (const r of responses) assert.equal(r.status, 403, host);
  }
});

test("every POST route refuses a missing, foreign or mismatched Origin", async () => {
  const scripts = fakeScripts();
  const live = fakeLive();
  const deps = testDeps({ runScript: scripts.runner, startLive: live.startLive, env: { ALLOW_LIVE: "true" } });
  const origins = [null, "null", "http://evil.example", "http://localhost:3000", "http://127.0.0.1:3001", "not a url"];
  for (const origin of origins) {
    const statuses = [
      (await postScript(req("POST", "/x", { origin }), "db-pool-exhaustion", "trigger", deps)).status,
      (await postScript(req("POST", "/x", { origin }), "db-pool-exhaustion", "reset", deps)).status,
      (await postLive(req("POST", "/x", { origin, body: { scenario_id: "db-pool-exhaustion" } }), deps)).status,
    ];
    assert.deepEqual(statuses, [403, 403, 403], String(origin));
  }
  assert.deepEqual(scripts.ran, []);
  assert.deepEqual(live.started, []);
  assert.throws(() => readFileSync(deps.stateFile), "a refused request must not use the live slot");
});

test("the same-origin POST from the page is accepted", async () => {
  const scripts = fakeScripts();
  const res = await postScript(req("POST", "/x", { origin: ORIGIN }), "db-pool-exhaustion", "trigger", testDeps({ runScript: scripts.runner }));
  assert.equal(res.status, 200);
  scripts.finish();
  await frames(res);
  await tick();
});

test("the server only listens on 127.0.0.1", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.dev, /^next dev -H 127\.0\.0\.1 /);
  assert.match(pkg.scripts.start, /^next start -H 127\.0\.0\.1 /);
});

// ── replay ───────────────────────────────────────────────────────────────────

test("GET /api/runs/replay streams a replay as run_event frames", async () => {
  const res = await getReplay(req("GET", "/api/runs/replay?name=db-pool-exhaustion.reconstructed.ndjson&speed=20"), testDeps());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const got = await frames(res);
  assert.deepEqual(got.map((f) => f.event), Array(got.length).fill("run_event"));
  assert.equal(got[0].data.type, "run_start");
  assert.equal(got.at(-1)!.data.type, "run_end");
});

test("replay names and speeds outside the allow-list are refused", async () => {
  const deps = testDeps();
  for (const [q, status] of [
    ["name=../../evals/results/db-pool-exhaustion.json", 400],
    ["name=%2Fetc%2Fpasswd", 400],
    ["name=nope.ndjson", 404],
    ["name=db-pool-exhaustion.reconstructed.ndjson&speed=0", 400],
    ["name=db-pool-exhaustion.reconstructed.ndjson&speed=1e9", 400],
  ] as const) {
    assert.equal((await getReplay(req("GET", `/api/runs/replay?${q}`), deps)).status, status, q);
  }
});
