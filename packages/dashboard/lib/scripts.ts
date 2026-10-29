import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { childOutput, scrubbedEnv } from "./child";
import { REPO_ROOT } from "./paths";

/** Runs one allow-listed script (see scenarios.ts resolveScript) and yields its output lines, redacted. */

export type ScriptEvent =
  | { type: "script_line"; line: string }
  | { type: "script_end"; ok: boolean; exit_code: number | null; seconds: number };

const MAX_LINE = 400;
const MAX_LINES = 2000;

/** Removes file-system locations from script output before it reaches the browser. */
export function redact(line: string, repoRoot = REPO_ROOT, home = homedir()): string {
  let out = line.split(repoRoot).join("<repo>");
  if (home && home !== "/") out = out.split(home).join("<home>");
  out = out
    .replace(/(?:\.\/)?\bsandbox\/[\w./-]+/g, "<path>")
    .replace(/\/var\/run\/docker\.sock/g, "<docker socket>")
    .replace(/<repo>\/[\w./-]*/g, "<path>")
    .replace(/<home>\/[\w./-]*/g, "<path>");
  return out.length > MAX_LINE ? `${out.slice(0, MAX_LINE)}…` : out;
}

export type ScriptRunner = (absPath: string) => AsyncIterable<ScriptEvent>;

/** bash <absPath>, from the repo root, with no arguments and a scrubbed environment. No shell string is built. */
export const runScript: ScriptRunner = async function* (absPath) {
  const t0 = performance.now();
  const child = spawn("bash", [absPath], { cwd: REPO_ROOT, env: scrubbedEnv() as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  let lines = 0;
  for await (const item of childOutput(child)) {
    if (item.kind === "line") {
      lines++;
      if (lines <= MAX_LINES) yield { type: "script_line", line: redact(item.line) };
      else if (lines === MAX_LINES + 1) yield { type: "script_line", line: "(further output omitted)" };
      continue;
    }
    yield {
      type: "script_end",
      ok: item.code === 0,
      exit_code: item.code,
      seconds: Math.round((performance.now() - t0) / 100) / 10,
    };
  }
};
