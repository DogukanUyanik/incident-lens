import { test } from "node:test";
import assert from "node:assert/strict";
import { getConfig, postScript } from "../lib/handlers";
import { fakeScripts, frames, req, testDeps } from "./http";

const ID = "db-pool-exhaustion";

test("REPLAY_ONLY=true refuses trigger and reset before anything runs", async () => {
  const scripts = fakeScripts();
  const deps = testDeps({ runScript: scripts.runner, env: { REPLAY_ONLY: "true" } });
  for (const kind of ["trigger", "reset"] as const) {
    const res = await postScript(req("POST", `/api/scenarios/${ID}/${kind}`), ID, kind, deps);
    assert.equal(res.status, 403, kind);
  }
  assert.deepEqual(scripts.ran, []);
  assert.equal((await (await getConfig(req("GET", "/api/config"), deps)).json()).replay_only, true);
});

test("scripts still run unless REPLAY_ONLY is exactly 'true'", async () => {
  for (const env of [{}, { REPLAY_ONLY: "false" }, { REPLAY_ONLY: "1" }]) {
    const scripts = fakeScripts();
    const deps = testDeps({ runScript: scripts.runner, env });
    const res = await postScript(req("POST", `/api/scenarios/${ID}/trigger`), ID, "trigger", deps);
    assert.equal(res.status, 200);
    scripts.finish();
    await frames(res);
    assert.equal(scripts.ran.length, 1);
    assert.equal((await (await getConfig(req("GET", "/api/config"), deps)).json()).replay_only, false);
  }
});
