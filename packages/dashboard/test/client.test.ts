import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { citationsOf, parseLabel, splitAround } from "../app/_client/citations";
import { parseFrame, readFrames } from "../app/_client/sse";
import { investigate } from "../../agent/src/agent.js";
import type { RunEvent } from "../lib/events";
import { parseReplay, REPLAYS_DIR } from "../lib/replay";
import { createRecorder } from "../lib/run-events";
import { sseFrame } from "../lib/sse";
import { callLogs, LOG_LINE, stubClient, stubTelemetry, submit } from "./stub";

/** The browser-side helpers: SSE parsing and how citations are built from a run's events. */

test("the browser's SSE parser reads what the server's SSE writer sends, split anywhere", async () => {
  const sent = [
    { event: "run_event", data: { seq: 0, text: "a\nb" } },
    { event: "script_line", data: { line: "==> Waiting…" } },
  ];
  const wire = sent.map(sseFrame).join("");
  for (const cut of [1, 7, 30, wire.length - 1]) {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(wire.slice(0, cut)));
        c.enqueue(new TextEncoder().encode(wire.slice(cut)));
        c.close();
      },
    });
    const got = [];
    for await (const f of readFrames(new Response(body))) got.push(f);
    assert.deepEqual(got, sent, `cut at ${cut}`);
  }
  assert.equal(parseFrame("event: x"), null);
  assert.equal(parseFrame("data: {not json"), null);
});

test("call labels give the tool and the container", () => {
  assert.deepEqual(parseLabel('get_container_logs {"container":"gateway","tail":50}'), { tool: "get_container_logs", container: "gateway" });
  assert.deepEqual(parseLabel('inspect_git_history {"service":"order-service"}'), { tool: "inspect_git_history", container: "order-service" });
  assert.deepEqual(parseLabel("get_cluster_topology {}"), { tool: "get_cluster_topology", container: null });
  assert.deepEqual(parseLabel("logs of the gateway"), { tool: "logs", container: null });
});

test("reconstructed replays: citations come from the stored checks and never carry a tool result", () => {
  for (const id of ["db-pool-exhaustion", "memory-leak-oom", "corrupt-deploy", "prometheus-bad-scrape-crash"]) {
    const events = parseReplay(readFileSync(path.join(REPLAYS_DIR, `${id}.reconstructed.ndjson`), "utf8"));
    const final = events.find((e) => e.type === "report_final") as Extract<RunEvent, { type: "report_final" }>;
    const cites = citationsOf(events);
    assert.equal(cites.length, final.checks.length, id);
    cites.forEach((c, i) => {
      assert.equal(c.quote, final.checks[i].quote);
      assert.equal(c.verified, final.checks[i].ok);
      assert.equal(c.label, final.checks[i].matchedIn[0]);
      assert.equal(c.result, undefined, `${id}: reconstructed replays have no tool output`);
    });
  }
});

test("live runs: a citation carries the output of the call it was verified in, and the quote is found in it", async () => {
  const rec = createRecorder({ run_id: "r", scenario_id: "s", alert: "a", model: "m", mode: "live", source: "live" });
  const events: RunEvent[] = [rec.start()];
  const result = await investigate("a", stubTelemetry(`noise\n${LOG_LINE}\nmore`), stubClient([callLogs(), submit()]), (e) =>
    events.push(rec.agent(e))
  );
  events.push(...rec.finish(result, 1));
  const [c] = citationsOf(events);
  assert.equal(c.tool, "get_container_logs");
  assert.equal(c.container, "order-service");
  assert.equal(c.verified, true);
  assert.equal(c.result?.text, `noise\n${LOG_LINE}\nmore`);
  assert.deepEqual(splitAround(c.result!.text, c.quote), ["noise\n", LOG_LINE, "\nmore"]);
  assert.equal(splitAround("abc", "zzz"), null);
});
