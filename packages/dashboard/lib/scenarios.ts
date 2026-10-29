import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths";

/**
 * The scenarios the dashboard may trigger and reset: the benchmark scenarios in evals/scenarios.json (fixtures are
 * excluded). Script paths stay on the server; the browser only ever sees id, title and alert.
 */

export interface PublicScenario {
  id: string;
  title: string;
  alert: string;
}

interface StoredScenario extends PublicScenario {
  trigger: string;
  reset: string;
  fixture?: boolean;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The only script locations allowed: a plain file name in sandbox/chaos/. */
const SCRIPT = /^\.\/sandbox\/chaos\/[a-z0-9][a-z0-9-]*\.sh$/;
const CHAOS_DIR = path.join(REPO_ROOT, "sandbox", "chaos");

export class ScenarioError extends Error {
  constructor(
    readonly status: 400 | 404 | 500,
    message: string
  ) {
    super(message);
  }
}

function load(file: string): StoredScenario[] {
  const data = JSON.parse(readFileSync(file, "utf8")) as { scenarios: StoredScenario[] };
  return data.scenarios.filter((s) => !s.fixture);
}

const SCENARIOS_FILE = path.join(REPO_ROOT, "evals", "scenarios.json");

export function listScenarios(file = SCENARIOS_FILE): PublicScenario[] {
  return load(file).map(({ id, title, alert }) => ({ id, title, alert }));
}

/**
 * Returns the absolute path of a scenario's trigger or reset script, or throws. The id must name a non-fixture
 * scenario, its script entry must match the strict pattern, and the resolved file (after symlinks) must be a file
 * directly inside sandbox/chaos/.
 */
export function resolveScript(id: string, kind: "trigger" | "reset", file = SCENARIOS_FILE): string {
  if (!ID.test(id)) throw new ScenarioError(400, "invalid scenario id");
  const s = load(file).find((x) => x.id === id);
  if (!s) throw new ScenarioError(404, "unknown scenario");
  const script = s[kind];
  if (typeof script !== "string" || !SCRIPT.test(script)) {
    throw new ScenarioError(500, `scenario ${id}: ${kind} script is not an allowed path`);
  }
  const abs = path.join(REPO_ROOT, script);
  if (!existsSync(abs)) throw new ScenarioError(500, `scenario ${id}: ${kind} script is missing`);
  const real = realpathSync(abs);
  if (path.dirname(real) !== realpathSync(CHAOS_DIR)) {
    throw new ScenarioError(500, `scenario ${id}: ${kind} script resolves outside sandbox/chaos`);
  }
  return real;
}

export function publicScenario(id: string, file = SCENARIOS_FILE): PublicScenario | undefined {
  return listScenarios(file).find((s) => s.id === id);
}
