import type { AgentEvent, AgentResult } from "../../agent/src/agent.js";
import { SCHEMA_VERSION, type EventBody, type RunEvent } from "./events";

export interface RunMeta {
  run_id: string;
  scenario_id: string;
  alert: string;
  model: string;
  mode: "replay" | "live";
  source: "live" | "reconstructed";
  started_at?: string;
  note?: string;
}

/**
 * Turns one run into schema events: adds the envelope (version, run id, sequence number, time since start) and the
 * events the agent itself never emits. The agent returns failures instead of emitting them (max_tokens twice, other
 * stop reasons, no report after the turn limit), so finish() converts a failed result into `error` + `run_end`.
 */
export function createRecorder(meta: RunMeta, now: () => number = () => performance.now()) {
  let seq = 0;
  let t0: number | undefined;
  const wrap = (body: EventBody): RunEvent => {
    const t = now();
    t0 ??= t;
    return { v: SCHEMA_VERSION, run_id: meta.run_id, seq: seq++, t_ms: Math.round(t - t0), ...body } as RunEvent;
  };

  return {
    start(): RunEvent {
      const { run_id: _id, ...rest } = meta;
      return wrap({ type: "run_start", ...rest });
    },

    agent(e: AgentEvent): RunEvent {
      if (e.type === "tool_result") return wrap({ ...e, truncated: e.text.startsWith("[TRUNCATED") });
      return wrap(e);
    },

    finish(result: Pick<AgentResult, "ok" | "failure" | "turns" | "usage">, seconds: number): RunEvent[] {
      const end = { turns: result.turns, usage: result.usage, seconds };
      if (result.ok) return [wrap({ type: "run_end", ok: true, ...end })];
      const failure = result.failure ?? "the agent returned no report";
      return [
        wrap({ type: "error", stage: "agent", message: failure }),
        wrap({ type: "run_end", ok: false, failure, ...end }),
      ];
    },

    /** The run threw before the agent returned a result (MCP server down, bad credentials, a bug). */
    crash(err: unknown, stage: "runner" | "mcp" = "runner"): RunEvent[] {
      const message = err instanceof Error ? err.message : String(err);
      return [
        wrap({ type: "error", stage, message }),
        wrap({ type: "run_end", ok: false, failure: message, turns: null, usage: null, seconds: null }),
      ];
    },
  };
}
