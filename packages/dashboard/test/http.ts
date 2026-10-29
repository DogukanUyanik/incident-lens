import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Deps } from "../lib/handlers";
import type { LiveRun } from "../lib/live";
import { pump } from "../lib/pump";
import { REPLAYS_DIR } from "../lib/replay";
import type { ScriptEvent, ScriptRunner } from "../lib/scripts";
import type { RunEvent } from "../lib/events";

/** Helpers for calling the API handlers directly, as the browser would, with fake dependencies. */

export const ORIGIN = "http://127.0.0.1:3000";

export function req(
  method: "GET" | "POST",
  pathAndQuery: string,
  { host = "127.0.0.1:3000", origin = method === "POST" ? ORIGIN : undefined, body }: { host?: string; origin?: string | null; body?: unknown } = {}
): Request {
  const headers = new Headers({ host });
  if (origin) headers.set("origin", origin);
  return new Request(`http://${host}${pathAndQuery}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export interface SseFrame {
  event: string;
  data: any;
}

/** Reads a whole SSE response into frames. */
export async function frames(res: Response): Promise<SseFrame[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((f) => f.trim())
    .map((f) => {
      const event = /^event: (.*)$/m.exec(f)?.[1] ?? "";
      const data = JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? "null");
      return { event, data };
    });
}

/**
 * A script runner that records what it was asked to run. Each run finishes on one `finish()` call; a call made
 * before the run is waiting is remembered, so the order of test steps and async steps doesn't matter.
 */
export function fakeScripts() {
  const ran: string[] = [];
  const waiting: ((ok: boolean) => void)[] = [];
  const early: boolean[] = [];
  const runner: ScriptRunner = async function* (abs): AsyncGenerator<ScriptEvent> {
    ran.push(abs);
    yield { type: "script_line", line: "==> working" };
    const ok = early.length ? early.shift()! : await new Promise<boolean>((r) => waiting.push(r));
    yield { type: "script_end", ok, exit_code: ok ? 0 : 1, seconds: 0.1 };
  };
  return {
    runner,
    ran,
    finish: (ok = true) => {
      const next = waiting.shift();
      if (next) next(ok);
      else early.push(ok);
    },
  };
}

/** A live run whose events are scripted and that ends when `end()` is called. */
export function fakeLive() {
  const started: string[] = [];
  let end!: () => void;
  const startLive = (scenarioId: string): LiveRun => {
    started.push(scenarioId);
    const gate = new Promise<void>((r) => (end = r));
    async function* events(): AsyncGenerator<RunEvent> {
      const base = { v: 1, run_id: "fake", t_ms: 0 } as const;
      yield { ...base, seq: 0, type: "run_start", scenario_id: scenarioId, alert: "a", model: "m", mode: "live", source: "live" };
      await gate;
      yield { ...base, seq: 1, type: "run_end", ok: true, turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, seconds: 1 };
    }
    const { items, done } = pump(events());
    return { run_id: "fake", file: "live/fake.ndjson", events: items, done };
  };
  return { startLive, started, end: () => end() };
}

export function testDeps(overrides: Partial<Deps> = {}): Deps & { stateFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "dashboard-state-"));
  return {
    env: {},
    now: () => Date.parse("2026-10-29T12:00:00Z"),
    stateFile: path.join(dir, "live.json"),
    replaysDir: REPLAYS_DIR,
    runScript: fakeScripts().runner,
    startLive: fakeLive().startLive,
    ...overrides,
  } as Deps & { stateFile: string };
}

export const tick = () => new Promise((r) => setTimeout(r, 10));
