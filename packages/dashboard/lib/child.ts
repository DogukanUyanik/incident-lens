import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export type ChildOutput =
  | { kind: "line"; stream: "stdout" | "stderr"; line: string }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null };

/** Yields a child's output line by line (stdout and stderr, in arrival order), then one final exit item. */
export async function* childOutput(child: ChildProcess): AsyncGenerator<ChildOutput> {
  const queue: ChildOutput[] = [];
  let wake: (() => void) | undefined;
  const push = (item: ChildOutput) => {
    queue.push(item);
    wake?.();
  };

  let open = 0;
  let exited: ChildOutput | undefined;
  const finish = () => {
    if (exited && open === 0) push(exited);
  };
  for (const stream of ["stdout", "stderr"] as const) {
    const s = child[stream];
    if (!s) continue;
    open++;
    const rl = createInterface({ input: s, crlfDelay: Infinity });
    rl.on("line", (line) => push({ kind: "line", stream, line }));
    rl.on("close", () => {
      open--;
      finish();
    });
  }
  child.on("error", (err) => push({ kind: "line", stream: "stderr", line: `failed to start: ${err.message}` }));
  child.on("close", (code, signal) => {
    exited = { kind: "exit", code, signal };
    finish();
  });

  while (true) {
    while (queue.length) {
      const item = queue.shift()!;
      yield item;
      if (item.kind === "exit") return;
    }
    await new Promise<void>((resolve) => (wake = resolve));
    wake = undefined;
  }
}

/**
 * The environment for child processes that don't need credentials (trigger/reset scripts): the server's
 * environment minus anything that looks like a secret, and minus ALLOW_LIVE.
 */
export type Env = Record<string, string | undefined>;

export function scrubbedEnv(env: Env = process.env): Env {
  const SECRET = /(^ANTHROPIC_|^AWS_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET.test(k) && k !== "ALLOW_LIVE"));
}
