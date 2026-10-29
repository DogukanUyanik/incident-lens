import { z } from "zod";
import { currentActivity, tryAcquire } from "./activity";
import type { Env } from "./child";
import type { RunEvent } from "./events";
import { checkLiveGate, liveEnabled, recordLiveStart, retryAfterSeconds } from "./live-gate";
import { startLive, type LiveRun } from "./live";
import { pump } from "./pump";
import { isReplayName, listReplays, loadReplay, REPLAYS_DIR, streamReplay } from "./replay";
import { guard, json } from "./request-guard";
import { listScenarios, publicScenario, resolveScript, ScenarioError } from "./scenarios";
import { runScript, type ScriptRunner } from "./scripts";
import { errorMessage, sseResponse, type SseMessage } from "./sse";

/**
 * The API, as plain functions of (Request, deps) → Response. The route files in app/api only call these with the
 * real dependencies; tests call them with fakes. Nothing here returns script paths, environment variables or file
 * system locations: responses carry scenario ids, titles, alerts, replay names and events only.
 */

export interface Deps {
  env: Env;
  now: () => number;
  /** Live rate-limit state file; undefined = the default in .state/. */
  stateFile?: string;
  /** evals/scenarios.json; undefined = the real one. */
  scenariosFile?: string;
  replaysDir: string;
  runScript: ScriptRunner;
  startLive: (scenarioId: string) => LiveRun;
}

export const realDeps = (): Deps => ({
  env: process.env,
  now: Date.now,
  replaysDir: REPLAYS_DIR,
  runScript,
  startLive: (id) => startLive(id),
});

const busyBody = () => {
  const a = currentActivity();
  return a && { kind: a.kind, scenario_id: a.scenario_id, since: a.since };
};

export async function getScenarios(request: Request, deps: Deps): Promise<Response> {
  const refused = guard(request, { post: false });
  if (refused) return refused;
  const { replays } = await listReplays(deps.replaysDir);
  const scenarios = listScenarios(deps.scenariosFile).map((s) => ({
    ...s,
    replays: replays.filter((r) => r.scenario_id === s.id).map(({ name, source, events }) => ({ name, source, events })),
  }));
  return json(200, { scenarios });
}

export async function getConfig(request: Request, deps: Deps): Promise<Response> {
  const refused = guard(request, { post: false });
  if (refused) return refused;
  return json(200, {
    live_enabled: liveEnabled(deps.env),
    live_retry_after_s: retryAfterSeconds(deps.now(), deps.stateFile),
    busy: busyBody(),
  });
}

export async function postScript(request: Request, id: string, kind: "trigger" | "reset", deps: Deps): Promise<Response> {
  const refused = guard(request, { post: true });
  if (refused) return refused;
  let script: string;
  try {
    script = resolveScript(id, kind, deps.scenariosFile);
  } catch (err) {
    if (err instanceof ScenarioError) return json(err.status, { error: err.status === 500 ? "scenario script is not allowed" : err.message });
    throw err;
  }
  const release = tryAcquire(kind, id);
  if (!release) return json(409, { error: "busy", busy: busyBody() });

  async function* messages(): AsyncGenerator<SseMessage> {
    yield { event: "script_start", data: { scenario_id: id, kind } };
    try {
      for await (const e of deps.runScript(script)) yield { event: e.type, data: e };
    } catch (err) {
      yield { event: "script_end", data: { type: "script_end", ok: false, exit_code: null, seconds: 0, error: errorMessage(err) } };
    }
  }
  const { items, done } = pump(messages());
  done.finally(release).catch(() => {});
  return sseResponse(items);
}

export async function getReplay(request: Request, deps: Deps): Promise<Response> {
  const refused = guard(request, { post: false });
  if (refused) return refused;
  const url = new URL(request.url);
  const name = url.searchParams.get("name") ?? "";
  if (!isReplayName(name)) return json(400, { error: "invalid replay name" });
  const speed = Number(url.searchParams.get("speed") ?? "1");
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 20) return json(400, { error: "speed must be 0.25–20" });

  let events: RunEvent[];
  try {
    events = await loadReplay(name, deps.replaysDir);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return json(missing ? 404 : 500, { error: missing ? "replay not found" : "replay file is invalid" });
  }
  const ctrl = new AbortController();
  async function* messages(): AsyncGenerator<SseMessage> {
    for await (const e of streamReplay(events, { speed, signal: ctrl.signal })) yield { event: "run_event", data: e };
  }
  return sseResponse(messages(), () => ctrl.abort());
}

const LiveBody = z.object({ scenario_id: z.string().max(64) }).strict();

export async function postLive(request: Request, deps: Deps): Promise<Response> {
  const refused = guard(request, { post: true });
  if (refused) return refused;
  const raw = await request.text();
  if (raw.length > 1024) return json(400, { error: "request body too large" });
  let body: z.infer<typeof LiveBody>;
  try {
    body = LiveBody.parse(JSON.parse(raw));
  } catch {
    return json(400, { error: 'expected {"scenario_id": "<id>"}' });
  }
  if (!publicScenario(body.scenario_id, deps.scenariosFile)) return json(404, { error: "unknown scenario" });

  // Order matters: a refused request must never use up the one-per-minute slot.
  if (!liveEnabled(deps.env)) return json(403, { error: "live runs are disabled (set ALLOW_LIVE=true)" });
  if (currentActivity()) return json(409, { error: "busy", busy: busyBody() });
  const gate = checkLiveGate(deps.env, deps.now(), deps.stateFile);
  if (!gate.ok) {
    const headers: Record<string, string> = gate.retry_after_s ? { "retry-after": String(gate.retry_after_s) } : {};
    return json(gate.status, { error: gate.message, retry_after_s: gate.retry_after_s }, headers);
  }
  const release = tryAcquire("live", body.scenario_id);
  if (!release) return json(409, { error: "busy", busy: busyBody() });
  recordLiveStart(deps.now(), deps.stateFile);

  let run: LiveRun;
  try {
    run = deps.startLive(body.scenario_id);
  } catch (err) {
    release();
    throw err;
  }
  run.done.finally(release).catch(() => {});
  async function* messages(): AsyncGenerator<SseMessage> {
    yield { event: "live_start", data: { run_id: run.run_id, replay: run.file } };
    for await (const e of run.events) yield { event: "run_event", data: e };
  }
  return sseResponse(messages());
}
