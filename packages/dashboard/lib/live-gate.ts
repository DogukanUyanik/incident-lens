import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "./child";
import { STATE_DIR } from "./paths";

/**
 * Whether a live (paid) run may start now: only with ALLOW_LIVE=true, and at most one start per minute. The time of
 * the last start is written to a file, so restarting the server does not reset the limit.
 */

export const LIVE_INTERVAL_MS = 60_000;
const STATE_FILE = path.join(STATE_DIR, "live.json");

export type GateResult = { ok: true } | { ok: false; status: 403 | 429; message: string; retry_after_s?: number };

export function liveEnabled(env: Env = process.env): boolean {
  return env.ALLOW_LIVE === "true";
}

function lastStart(file: string): number | undefined {
  try {
    const t = (JSON.parse(readFileSync(file, "utf8")) as { last_started_at?: unknown }).last_started_at;
    const ms = typeof t === "string" ? Date.parse(t) : NaN;
    return Number.isNaN(ms) ? undefined : ms;
  } catch {
    return undefined;
  }
}

/** Seconds until a live run may start again (0 when it may start now). */
export function retryAfterSeconds(now = Date.now(), file = STATE_FILE): number {
  const last = lastStart(file);
  if (last === undefined) return 0;
  return Math.max(0, Math.ceil((last + LIVE_INTERVAL_MS - now) / 1000));
}

export function checkLiveGate(env: Env = process.env, now = Date.now(), file = STATE_FILE): GateResult {
  if (!liveEnabled(env)) return { ok: false, status: 403, message: "live runs are disabled (set ALLOW_LIVE=true)" };
  const wait = retryAfterSeconds(now, file);
  if (wait > 0) return { ok: false, status: 429, message: "one live run per minute", retry_after_s: wait };
  return { ok: true };
}

/** Records a start. Written atomically (temp file + rename), before the run begins. */
export function recordLiveStart(now = Date.now(), file = STATE_FILE): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ last_started_at: new Date(now).toISOString() }) + "\n");
  renameSync(tmp, file);
}
