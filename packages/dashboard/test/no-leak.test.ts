import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { scrubbedEnv } from "../lib/child";
import { getConfig, getReplay, getScenarios, postLive, postScript } from "../lib/handlers";
import { REPO_ROOT } from "../lib/paths";
import { redact } from "../lib/scripts";
import { fakeLive, fakeScripts, frames, req, testDeps, tick } from "./http";

/** Nothing that identifies the machine, its files or its credentials may reach the browser. */

const SECRET = "sk-ant-api03-THIS-IS-A-TEST-SECRET";
const FORBIDDEN = [SECRET, REPO_ROOT, homedir(), "sandbox/chaos", ".sh", "docker.sock", "ANTHROPIC", "ALLOW_LIVE", "PATH="];

function assertClean(label: string, text: string) {
  for (const f of FORBIDDEN) assert.ok(!text.includes(f), `${label} leaks ${JSON.stringify(f)}: ${text.slice(0, 300)}`);
}

test("no API response contains secrets, script paths, file paths or environment variables", async () => {
  process.env.ANTHROPIC_API_KEY = SECRET; // as if the server had it in its environment
  const env = { ...process.env, ALLOW_LIVE: "true", ANTHROPIC_API_KEY: SECRET };
  const scripts = fakeScripts();
  const live = fakeLive();
  const deps = testDeps({ env, runScript: scripts.runner, startLive: live.startLive });

  assertClean("GET /api/scenarios", await (await getScenarios(req("GET", "/api/scenarios"), deps)).text());
  assertClean("GET /api/config", await (await getConfig(req("GET", "/api/config"), deps)).text());

  const trig = await postScript(req("POST", "/x"), "prometheus-bad-scrape-crash", "trigger", deps);
  scripts.finish();
  assertClean("POST trigger", JSON.stringify(await frames(trig)));
  await tick();

  const errors = [
    await postScript(req("POST", "/x"), "nope", "reset", deps),
    await postScript(req("POST", "/x", { origin: "http://evil.example" }), "corrupt-deploy", "reset", deps),
    await getReplay(req("GET", "/api/runs/replay?name=../x"), deps),
    await postLive(req("POST", "/x", { body: "{" }), deps),
  ];
  for (const r of errors) assertClean(`error ${r.status}`, await r.text());

  const liveRes = await postLive(req("POST", "/api/runs/live", { body: { scenario_id: "corrupt-deploy" } }), deps);
  live.end();
  assertClean("POST live", JSON.stringify(await frames(liveRes)));
  await tick();
  delete process.env.ANTHROPIC_API_KEY;
});

test("script output is redacted before it is sent", () => {
  const home = homedir();
  const lines = [
    `Run ./sandbox/chaos/reset.sh first.`,
    `compose file "${REPO_ROOT}/sandbox/docker-compose.yml" is invalid`,
    `open ${home}/.docker/config.json: permission denied`,
    `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`,
    `==> Applying sandbox/docker-compose.prometheus-bad-scrape.yml`,
  ];
  for (const l of lines) assertClean("redact", redact(l));
  assert.equal(redact("==> PASS: sandbox is healthy (GET /orders -> 200)."), "==> PASS: sandbox is healthy (GET /orders -> 200).");
  assert.equal(redact("x".repeat(1000)).length, 401);
});

test("trigger/reset scripts get no credentials and no ALLOW_LIVE", () => {
  const env = scrubbedEnv({
    PATH: "/usr/bin",
    HOME: "/home/u",
    DOCKER_HOST: "unix:///x",
    COMPOSE_PROJECT: "sandbox",
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_AUTH_TOKEN: "t",
    AWS_SECRET_ACCESS_KEY: "a",
    GITHUB_TOKEN: "g",
    DB_PASSWORD: "p",
    ALLOW_LIVE: "true",
  });
  assert.deepEqual(Object.keys(env).sort(), ["COMPOSE_PROJECT", "DOCKER_HOST", "HOME", "PATH"]);
});

test("no browser-exposed environment variables and no server modules in client code", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) files.push(p);
    }
  };
  for (const d of ["app", "lib", "runner"]) walk(d);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("NEXT_PUBLIC_"), `${f} uses a NEXT_PUBLIC_ variable`);
    if (src.includes('"use client"')) {
      assert.ok(!/from "node:|lib\/(handlers|live|scripts|child|scenarios|paths)/.test(src), `${f}: client code imports server modules`);
    }
  }
});

test("React effects use a block body, so a value returned by a DOM call is never taken as the cleanup", () => {
  // Regression: `useEffect(() => el.scrollIntoView(...))` crashed the page in Chromium 155 once the effect re-ran.
  const dir = path.join("app", "_components");
  for (const f of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/useEffect\(\s*\(\)\s*=>\s*[^{\s]/.test(src), `${f}: useEffect with an expression body`);
  }
});
