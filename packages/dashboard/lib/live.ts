import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { childOutput } from "./child";
import { RunEvent, SCHEMA_VERSION } from "./events";
import { DASHBOARD_DIR, REPLAYS_DIR } from "./paths";
import { pump } from "./pump";

/**
 * Starts one live run in a child process (runner/run-agent.ts) and saves every event it prints as a new replay file
 * in replays/live/. The run goes on to the end even if the browser disconnects. If the runner dies before run_end,
 * the server adds error + run_end itself, so every saved file is a complete, valid replay.
 */

export type SpawnRunner = (scenarioId: string, runId: string) => ChildProcess;

export const spawnRunner: SpawnRunner = (scenarioId, runId) =>
  spawn(path.join(DASHBOARD_DIR, "node_modules", ".bin", "tsx"), ["runner/run-agent.ts", scenarioId, runId], {
    cwd: DASHBOARD_DIR,
    // The runner needs the API credentials; it is the only child that gets the full environment.
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** 2026-10-29T12:00:00.000Z → 20261029-120000 (lowercase, so it passes isReplayName). */
export function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

export interface LiveRun {
  run_id: string;
  /** Replay name, relative to replays/. */
  file: string;
  events: AsyncIterable<RunEvent>;
  done: Promise<void>;
}

export function startLive(
  scenarioId: string,
  { spawn: spawnFn = spawnRunner, replaysDir = REPLAYS_DIR, now = new Date(), log = console.error } = {}
): LiveRun {
  const id = stamp(now);
  const run_id = `live-${scenarioId}-${id}`;
  const file = `live/${scenarioId}-${id}.ndjson`;
  const abs = path.join(replaysDir, file);
  mkdirSync(path.dirname(abs), { recursive: true });

  async function* events(): AsyncGenerator<RunEvent> {
    const child = spawnFn(scenarioId, run_id);
    let next = 0;
    let ended = false;
    const save = (e: RunEvent) => {
      appendFileSync(abs, `${JSON.stringify(e)}\n`);
      next = e.seq + 1;
      if (e.type === "run_end") ended = true;
      return e;
    };

    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    for await (const item of childOutput(child)) {
      if (item.kind === "exit") {
        exit = item;
        break;
      }
      if (item.stream === "stderr") {
        log(`[live ${run_id}] ${item.line}`); // agent console output: server log only
        continue;
      }
      let parsed: ReturnType<typeof RunEvent.safeParse>;
      try {
        parsed = RunEvent.safeParse(JSON.parse(item.line));
      } catch {
        log(`[live ${run_id}] ignored non-JSON stdout line`);
        continue;
      }
      if (!parsed.success || parsed.data.run_id !== run_id || parsed.data.seq !== next || ended) {
        log(`[live ${run_id}] ignored an event that is invalid, out of order or from another run`);
        continue;
      }
      yield save(parsed.data);
    }

    if (!ended) {
      const base = { v: SCHEMA_VERSION, run_id, t_ms: null } as const;
      if (next === 0) {
        yield save({ ...base, seq: 0, type: "run_start", scenario_id: scenarioId, alert: "", model: "unknown", mode: "live", source: "live" });
      }
      const message = `the runner exited (code ${exit.code ?? "none"}${exit.signal ? `, signal ${exit.signal}` : ""}) before the run ended`;
      yield save({ ...base, seq: next, type: "error", stage: "runner", message });
      yield save({ ...base, seq: next, type: "run_end", ok: false, failure: message, turns: null, usage: null, seconds: null });
    }
  }

  const { items, done } = pump(events());
  return { run_id, file, events: items, done };
}
