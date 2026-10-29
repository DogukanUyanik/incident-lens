import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { benchmarkable, loadScenarios, type Scenario } from "./scenarios.js";

const EXISTING = ["db-pool-exhaustion", "memory-leak-oom", "corrupt-deploy"];

test("the existing scenarios load as before and are the first benchmarkable ones", () => {
  const all = loadScenarios();
  const bench = benchmarkable(all);
  assert.deepEqual(bench.slice(0, EXISTING.length).map((s) => s.id), EXISTING);
  for (const s of bench.slice(0, EXISTING.length)) {
    assert.equal(s.upstream, undefined, s.id);
    assert.equal(s.compose_files, undefined, s.id);
    assert.equal(s.fixture, undefined, s.id);
    assert.ok(s.grading.groups.length > 0, s.id);
  }
});

test("the upstream fixture loads with its pin and is never benchmarked", () => {
  const fixture = loadScenarios().find((s) => s.id === "upstream-fixture");
  assert.ok(fixture);
  assert.equal(fixture.fixture, true);
  assert.deepEqual(fixture.upstream?.pin, { image: "traefik/whoami:v1.10.3" });
  assert.deepEqual(fixture.compose_files, ["sandbox/docker-compose.upstream-fixture.yml"]);
  assert.ok(!benchmarkable(loadScenarios()).some((s) => s.id === "upstream-fixture"));
});

test("prometheus-bad-scrape-crash loads with its pin and is benchmarkable", () => {
  const s = loadScenarios().find((x) => x.id === "prometheus-bad-scrape-crash");
  assert.ok(s);
  assert.equal(s.fixture, undefined);
  assert.deepEqual(s.upstream?.pin, { image: "prom/prometheus:v3.10.0" });
  assert.equal(s.upstream?.issue_url, "https://github.com/prometheus/prometheus/issues/18225");
  assert.equal(
    s.upstream?.fix_commit_url,
    "https://github.com/prometheus/prometheus/commit/3b44b8b463be9291a5605b935a5fbeda88db1366"
  );
  assert.deepEqual(s.compose_files, ["sandbox/docker-compose.prometheus-bad-scrape.yml"]);
  assert.deepEqual(s.grading.groups.map((g) => g.name), ["crash", "scrape", "loc"]);
  assert.ok(benchmarkable(loadScenarios()).some((x) => x.id === "prometheus-bad-scrape-crash"));
});

// ── loader validation of the upstream fields ─────────────────────────────────────────────────────────────────

const dir = mkdtempSync(path.join(tmpdir(), "incidentlens-scenarios-"));
let fileNo = 0;

function base(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "x",
    title: "x",
    alert: "x",
    ground_truth: "x",
    trigger: "./t.sh",
    reset: "./r.sh",
    precondition: { description: "x", checks: [] },
    grading: { groups: [{ name: "g", scope: "root_cause", negatable: false, patterns: ["x"] }] },
    upstream: {
      project: "acme/app",
      repo: "https://github.com/acme/app",
      pin: { image: "acme/app:1.2.3" },
      issue_url: "https://github.com/acme/app/issues/1",
      fix_commit_url: "https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567",
    },
    ...overrides,
  };
}

function load(s: unknown): Scenario[] {
  const file = path.join(dir, `s${fileNo++}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, scenarios: [s] }));
  return loadScenarios(file);
}

const withUpstream = (patch: Record<string, unknown>) => base({ upstream: { ...base().upstream!, ...patch } as never });

test("valid upstream pins load", () => {
  load(base());
  load(withUpstream({ pin: { image: "registry.example:5000/acme/app:v2" } }));
  load(withUpstream({ pin: { image: `acme/app@sha256:${"a".repeat(64)}` } }));
  load(withUpstream({ pin: { commit: "0123456789abcdef0123456789abcdef01234567" } }));
});

test("the loader rejects unpinned or incomplete upstream blocks", () => {
  const cases: [string, unknown, RegExp][] = [
    ["latest tag", withUpstream({ pin: { image: "acme/app:latest" } }), /pinned/],
    ["untagged image", withUpstream({ pin: { image: "acme/app" } }), /pinned/],
    ["registry port is not a tag", withUpstream({ pin: { image: "registry.example:5000/acme/app" } }), /pinned/],
    ["short sha", withUpstream({ pin: { commit: "0123456" } }), /40-char/],
    ["image and commit", withUpstream({ pin: { image: "acme/app:1", commit: "0".repeat(40) } }), /exactly one/],
    ["no pin", withUpstream({ pin: {} }), /exactly one/],
    ["missing issue_url", withUpstream({ issue_url: undefined }), /issue_url/],
    ["non-https fix commit", withUpstream({ fix_commit_url: "http://x" }), /fix_commit_url/],
    ["missing compose file", base({ compose_files: ["sandbox/does-not-exist.yml"] }), /not found/],
    ["no grading groups", base({ grading: { groups: [] } }), /no grading groups/],
  ];
  for (const [name, s, err] of cases) assert.throws(() => load(s), err, name);
});

test("a fixture may have no grading groups", () => {
  load(base({ fixture: true, grading: { groups: [] } }));
});
