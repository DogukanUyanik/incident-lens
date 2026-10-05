import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
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

export interface Scenario {
  id: string;
  title: string;
  alert: string;
  ground_truth: string;
  trigger: string;
  reset: string;
  precondition: { description: string; checks: PreconditionCheck[] };
  grading: Grading;
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
  }
  return data.scenarios;
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
