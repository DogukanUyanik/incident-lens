import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunEvent } from "./events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPLAYS_DIR = path.resolve(here, "../replays");

/** Replay names the server accepts: a file directly in replays/ or replays/live/, nothing else. */
const REPLAY_NAME = /^(live\/)?[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.ndjson$/;

export function isReplayName(name: string): boolean {
  return REPLAY_NAME.test(name);
}

/** Parses and checks a whole replay file. Throws with the 1-based line number of the first problem. */
export function parseReplay(text: string): RunEvent[] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const events = lines.map((line, i) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(`line ${i + 1}: not valid JSON (${String(err)})`);
    }
    const parsed = RunEvent.safeParse(json);
    if (!parsed.success) throw new Error(`line ${i + 1}: ${parsed.error.message}`);
    return parsed.data;
  });
  if (events.length === 0) throw new Error("empty replay");
  if (events[0].type !== "run_start") throw new Error("line 1: the first event must be run_start");
  if (events.at(-1)!.type !== "run_end") throw new Error(`line ${events.length}: the last event must be run_end`);
  events.forEach((e, i) => {
    if (e.seq !== i) throw new Error(`line ${i + 1}: seq is ${e.seq}, expected ${i}`);
    if (e.run_id !== events[0].run_id) throw new Error(`line ${i + 1}: run_id differs from run_start`);
  });
  return events;
}

export interface ReplayInfo {
  name: string;
  scenario_id: string;
  source: "live" | "reconstructed";
  events: number;
}

/** Lists the valid replay files; invalid ones are reported in `invalid` rather than served. */
export async function listReplays(dir = REPLAYS_DIR): Promise<{ replays: ReplayInfo[]; invalid: string[] }> {
  const names = [
    ...(await readdir(dir).catch(() => [] as string[])),
    ...(await readdir(path.join(dir, "live")).catch(() => [] as string[])).map((f) => `live/${f}`),
  ].filter(isReplayName);
  const replays: ReplayInfo[] = [];
  const invalid: string[] = [];
  for (const name of names.sort()) {
    try {
      const events = parseReplay(await readFile(path.join(dir, name), "utf8"));
      const start = events[0] as Extract<RunEvent, { type: "run_start" }>;
      replays.push({ name, scenario_id: start.scenario_id, source: start.source, events: events.length });
    } catch {
      invalid.push(name);
    }
  }
  return { replays, invalid };
}

export async function loadReplay(name: string, dir = REPLAYS_DIR): Promise<RunEvent[]> {
  if (!isReplayName(name)) throw new Error(`invalid replay name "${name}"`);
  return parseReplay(await readFile(path.join(dir, name), "utf8"));
}

export interface StreamOptions {
  /** 1 = recorded pace; 2 = twice as fast. */
  speed?: number;
  /** Cap for one recorded gap, so a slow tool call doesn't stall the replay. */
  maxGapMs?: number;
  /** Pause per event when the replay has no timings (reconstructed). */
  fixedDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The pause before each event: the recorded gap (capped) when both timings exist, otherwise the fixed delay. */
export function replayDelays(events: RunEvent[], opts: StreamOptions = {}): number[] {
  const { speed = 1, maxGapMs = 1500, fixedDelayMs = 400 } = opts;
  return events.map((e, i) => {
    if (i === 0) return 0;
    const prev = events[i - 1].t_ms;
    const gap = e.t_ms !== null && prev !== null ? Math.min(Math.max(e.t_ms - prev, 0), maxGapMs) : fixedDelayMs;
    return gap / speed;
  });
}

/** Yields the events of a replay with the pauses above; stops early when `signal` aborts (the browser left). */
export async function* streamReplay(events: RunEvent[], opts: StreamOptions = {}): AsyncGenerator<RunEvent> {
  const sleep = opts.sleep ?? realSleep;
  const delays = replayDelays(events, opts);
  for (let i = 0; i < events.length; i++) {
    if (opts.signal?.aborted) return;
    if (delays[i] > 0) await sleep(delays[i]);
    if (opts.signal?.aborted) return;
    yield events[i];
  }
}
