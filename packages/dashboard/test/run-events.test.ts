import { test } from "node:test";
import assert from "node:assert/strict";
import { investigate, MAX_TURNS } from "../../agent/src/agent.js";
import type { RunEvent } from "../lib/events";
import { parseReplay } from "../lib/replay";
import { toNdjson } from "../lib/reconstruct";
import { createRecorder } from "../lib/run-events";
import { callLogs, message, stubClient, stubTelemetry, submit } from "./stub";

const META = {
  run_id: "run-1",
  scenario_id: "db-pool-exhaustion",
  alert: "the gateway is returning 504",
  model: "stub-model",
  mode: "live" as const,
  source: "live" as const,
};

/** What the live runner will do: run_start, every agent event, then finish() (or crash() if it throws). */
async function record(responses: ReturnType<typeof message>[], telemetry = stubTelemetry()) {
  let clock = 0;
  const rec = createRecorder(META, () => (clock += 10));
  const events: RunEvent[] = [rec.start()];
  try {
    const result = await investigate(META.alert, telemetry, stubClient(responses), (e) => events.push(rec.agent(e)));
    events.push(...rec.finish(result, 1.5));
  } catch (err) {
    events.push(...rec.crash(err));
  }
  parseReplay(toNdjson(events)); // every recorded run must be a valid replay
  return events;
}

const tail = (events: RunEvent[]) => events.slice(-2);

test("a successful run ends with run_end ok and no error event", async () => {
  const events = await record([callLogs(), submit()]);
  assert.equal(events[0].type, "run_start");
  assert.ok(!events.some((e) => e.type === "error"));
  const end = events.at(-1)!;
  assert.ok(end.type === "run_end");
  assert.equal(end.ok, true);
  assert.equal(end.turns, 2);
  assert.equal(end.seconds, 1.5);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i));
});

test("max_tokens twice becomes error + run_end with the agent's failure", async () => {
  const truncated = () => message("max_tokens", [{ type: "text", text: "cut" }], 16000);
  const events = await record([truncated(), truncated()]);
  const failure = "stopped with stop_reason=max_tokens";
  assert.deepEqual(
    tail(events).map(({ v, run_id, seq, t_ms, ...body }) => body),
    [
      { type: "error", stage: "agent", message: failure },
      { type: "run_end", ok: false, failure, turns: 1, usage: { input_tokens: 200, output_tokens: 32000 }, seconds: 1.5 },
    ]
  );
  assert.ok(events.some((e) => e.type === "retry"));
});

test("another stop reason (refusal) becomes error + run_end", async () => {
  const events = await record([message("refusal", [])]);
  const [err, end] = tail(events);
  assert.ok(err.type === "error" && end.type === "run_end");
  assert.equal(err.message, "stopped with stop_reason=refusal");
  assert.equal(end.ok, false);
  assert.equal(end.failure, err.message);
});

test("no report after the turn limit becomes error + run_end", async () => {
  const events = await record(Array.from({ length: MAX_TURNS }, (_, i) => callLogs(`t${i}`)));
  const [err, end] = tail(events);
  assert.ok(err.type === "error" && end.type === "run_end");
  assert.equal(err.message, `no verified report after ${MAX_TURNS} turns`);
  assert.equal(end.turns, MAX_TURNS);
  assert.equal(events.filter((e) => e.type === "turn_start").length, MAX_TURNS);
});

test("a crash before the agent returns becomes error (runner) + run_end with unknown totals", async () => {
  const broken = { ...stubTelemetry(), callTool: async () => Promise.reject(new Error("MCP server exited")) };
  const events = await record([callLogs()], broken);
  const [err, end] = tail(events);
  assert.deepEqual(
    [err.type === "error" && [err.stage, err.message], end.type === "run_end" && [end.ok, end.turns, end.usage]],
    [["runner", "MCP server exited"], [false, null, null]]
  );
});

test("tool results get the truncated flag from the MCP server's marker", async () => {
  const events = await record([callLogs(), submit("tail of the log")], stubTelemetry("[TRUNCATED: ...]\ntail of the log"));
  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result?.type === "tool_result");
  assert.equal(result.truncated, true);
});

test("t_ms counts from run_start", async () => {
  const events = await record([callLogs(), submit()]);
  assert.equal(events[0].t_ms, 0);
  assert.deepEqual(events.slice(0, 3).map((e) => e.t_ms), [0, 10, 20]);
});
