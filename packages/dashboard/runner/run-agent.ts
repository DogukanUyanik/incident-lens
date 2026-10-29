import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { investigate } from "../../agent/src/agent.js";
import { connectTelemetry } from "../../agent/src/mcp.js";
import { SUBMIT_REPORT } from "../../agent/src/report.js";
import { checkPrecondition, loadScenarios } from "../../../evals/scenarios.js";
import type { RunEvent } from "../lib/events";
import { createRecorder } from "../lib/run-events";
import { stubClient, stubScript, stubTelemetry } from "./stub";

/**
 * One live agent run, started by the dashboard server (lib/live.ts):
 *   tsx runner/run-agent.ts <scenario-id> <run-id>
 * Prints one schema event per line on stdout and nothing else; all other output goes to stderr.
 * AGENT_STUB=1 swaps in the scripted model and telemetry: no API call, no Docker, no precondition.
 */

console.log = console.info = (...args: unknown[]) => console.error(...args);
const emit = (e: RunEvent) => process.stdout.write(`${JSON.stringify(e)}\n`);

const [scenarioId, runId] = process.argv.slice(2);
const stub = process.env.AGENT_STUB === "1";
const scenario = loadScenarios().find((s) => s.id === scenarioId && !s.fixture);
if (!scenario || !runId) {
  console.error(`usage: run-agent.ts <scenario-id> <run-id> (unknown scenario "${scenarioId}")`);
  process.exit(2);
}

if (!stub) {
  // Same credentials file the agent CLI uses (packages/agent/.env); variables already set win.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envFile = path.resolve(here, "../../agent/.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const rec = createRecorder({
  run_id: runId,
  scenario_id: scenario.id,
  alert: scenario.alert,
  model: stub ? "stub-model" : (process.env.INCIDENTLENS_MODEL ?? "claude-sonnet-5-5"),
  mode: "live",
  source: "live",
  started_at: new Date().toISOString(),
  ...(stub && { note: "Stub run (AGENT_STUB=1): scripted model and telemetry, no real investigation." }),
});
emit(rec.start());

const t0 = performance.now();
try {
  if (!stub) {
    // Don't spend tokens on a sandbox where the failure isn't active.
    const failures = await checkPrecondition(scenario);
    if (failures.length > 0) throw new Error(`scenario is not active (trigger it first): ${failures.join("; ")}`);
  }
  const telemetry = stub ? stubTelemetry() : await connectTelemetry();
  try {
    if (telemetry.tools.some((t) => t.name === SUBMIT_REPORT)) {
      throw new Error(`MCP server exposes a tool named "${SUBMIT_REPORT}", which clashes with the agent's own tool`);
    }
    const client = stub ? stubClient(stubScript(), Number(process.env.STUB_DELAY_MS ?? 300)) : undefined;
    const result = await investigate(scenario.alert, telemetry, client, (e) => emit(rec.agent(e)));
    for (const e of rec.finish(result, (performance.now() - t0) / 1000)) emit(e);
  } finally {
    await telemetry.close();
  }
} catch (err) {
  for (const e of rec.crash(err)) emit(e);
}
process.exit(0);
