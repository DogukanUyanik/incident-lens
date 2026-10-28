import { existsSync, readFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..");
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT ?? "sandbox";

export interface GradingGroup {
  name: string;
  scope: "root_cause" | "root_cause_or_summary";
  negatable: boolean;
  patterns: string[];
}

export interface Grading {
  groups: GradingGroup[];
}

export type PreconditionCheck =
  | {
      type: "http";
      method: string;
      url: string;
      body?: unknown;
      expect_status: number;
      max_ms?: number;
      timeout_ms?: number;
    }
  | { type: "docker"; service: string; min_restart_count?: number; memory_limit_set?: boolean; running?: boolean };

/**
 * A scenario whose broken service is a pinned third-party project. The issue and fix commit are the source of its
 * ground truth, so the answer is known independently of us.
 */
export interface Upstream {
  project: string;
  repo: string;
  pin: { image: string } | { commit: string };
  issue_url: string;
  fix_commit_url: string;
}

export interface Scenario {
  id: string;
  title: string;
  alert: string;
  ground_truth: string;
  trigger: string;
  reset: string;
  precondition: { description: string; checks: PreconditionCheck[] };
  grading: Grading;
  upstream?: Upstream;
  /** Repo-relative compose overrides merged onto sandbox/docker-compose.yml, so their services join the sandbox project. */
  compose_files?: string[];
  /** Plumbing test only: never benchmarked or graded. */
  fixture?: boolean;
}

export function loadScenarios(file = path.join(here, "scenarios.json")): Scenario[] {
  const data = JSON.parse(readFileSync(file, "utf8")) as { version: number; scenarios: Scenario[] };
  if (data.version !== 1) throw new Error(`${file}: unsupported version ${data.version}`);
  for (const s of data.scenarios) {
    for (const g of s.grading.groups) for (const p of g.patterns) new RegExp(p); // fail early on a bad regex
    for (const c of s.precondition.checks) {
      if (c.type !== "http" && c.type !== "docker") {
        throw new Error(`scenario ${s.id}: unknown precondition check type "${(c as { type: string }).type}"`);
      }
    }
    if (!s.fixture && s.grading.groups.length === 0) throw new Error(`scenario ${s.id}: no grading groups`);
    if (s.upstream) validateUpstream(s.id, s.upstream);
    for (const f of s.compose_files ?? []) {
      if (!existsSync(path.resolve(REPO_ROOT, f))) throw new Error(`scenario ${s.id}: compose file ${f} not found`);
    }
  }
  return data.scenarios;
}

const IMAGE_PIN = /^[^\s@]+(:[\w][\w.-]*|@sha256:[0-9a-f]{64})$/; // explicit tag or digest
const COMMIT_PIN = /^[0-9a-f]{40}$/;

function validateUpstream(id: string, u: Upstream): void {
  const fail = (msg: string): never => {
    throw new Error(`scenario ${id}: upstream ${msg}`);
  };
  if (!u.project) fail("project is missing");
  for (const key of ["repo", "issue_url", "fix_commit_url"] as const) {
    if (typeof u[key] !== "string" || !u[key].startsWith("https://")) fail(`${key} must be an https:// URL`);
  }
  const pin = (u.pin ?? {}) as { image?: unknown; commit?: unknown };
  if ((pin.image === undefined) === (pin.commit === undefined)) fail("pin needs exactly one of image or commit");
  if (pin.image !== undefined) {
    const image = String(pin.image);
    // A tag needs a ':' after the last '/', otherwise "host:5000/name" would count as tagged.
    const tagged = IMAGE_PIN.test(image) && (image.includes("@") || image.lastIndexOf(":") > image.lastIndexOf("/"));
    if (!tagged || image.endsWith(":latest")) fail(`image "${image}" must be pinned to a tag (not latest) or digest`);
  }
  if (pin.commit !== undefined && !COMMIT_PIN.test(String(pin.commit))) {
    fail(`commit "${String(pin.commit)}" must be a full 40-char sha`);
  }
}

/** The scenarios the benchmark may run: everything except plumbing fixtures. */
export function benchmarkable(scenarios: Scenario[]): Scenario[] {
  return scenarios.filter((s) => !s.fixture);
}

/** Runs a repo-relative trigger/reset script, streaming its output. True on exit code 0. */
export function runScript(script: string): boolean {
  console.log(`\n$ ${script}`);
  const res = spawnSync("bash", [script], { cwd: REPO_ROOT, stdio: "inherit" });
  return res.status === 0;
}

async function checkHttp(c: Extract<PreconditionCheck, { type: "http" }>): Promise<string | null> {
  const t0 = performance.now();
  let status: number;
  try {
    const res = await fetch(c.url, {
      method: c.method,
      headers: c.body === undefined ? undefined : { "content-type": "application/json" },
      body: c.body === undefined ? undefined : JSON.stringify(c.body),
      signal: AbortSignal.timeout(c.timeout_ms ?? 8000),
    });
    await res.arrayBuffer();
    status = res.status;
  } catch (err) {
    const cause = err instanceof Error && err.cause ? ` (${String(err.cause)})` : "";
    return `${c.method} ${c.url} failed: ${String(err)}${cause}`;
  }
  const ms = performance.now() - t0;
  if (status !== c.expect_status) return `${c.method} ${c.url} returned ${status}, expected ${c.expect_status}`;
  if (c.max_ms !== undefined && ms > c.max_ms) {
    return `${c.method} ${c.url} returned ${status} after ${Math.round(ms)}ms, expected within ${c.max_ms}ms`;
  }
  return null;
}

async function checkDocker(c: Extract<PreconditionCheck, { type: "docker" }>): Promise<string | null> {
  let out: string;
  try {
    const { stdout: id } = await execFileAsync("docker", [
      "ps", "-aq",
      "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
      "--filter", `label=com.docker.compose.service=${c.service}`,
    ]);
    if (!id.trim()) return `no ${c.service} container in compose project "${COMPOSE_PROJECT}"`;
    ({ stdout: out } = await execFileAsync("docker", [
      "inspect", id.trim().split("\n")[0],
      "--format", "{{.RestartCount}} {{.HostConfig.Memory}} {{.State.Running}}",
    ]));
  } catch (err) {
    return `docker inspect of ${c.service} failed: ${String(err)}`;
  }
  const [restarts, memory, running] = out.trim().split(" ");
  if (c.min_restart_count !== undefined && Number(restarts) < c.min_restart_count) {
    return `${c.service} restart count is ${restarts}, expected at least ${c.min_restart_count}`;
  }
  if (c.memory_limit_set && Number(memory) <= 0) return `${c.service} has no memory limit set`;
  if (c.running !== undefined && (running === "true") !== c.running) {
    return `${c.service} running=${running}, expected ${c.running}`;
  }
  return null;
}

/** Returns the list of failed checks (empty when the failure is active). Read-only: never changes the sandbox. */
export async function checkPrecondition(s: Scenario): Promise<string[]> {
  const failures: string[] = [];
  for (const c of s.precondition.checks) {
    const failure = c.type === "http" ? await checkHttp(c) : await checkDocker(c);
    if (failure) failures.push(failure);
  }
  return failures;
}
