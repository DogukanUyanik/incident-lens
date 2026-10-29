import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickRun, reconstruct, toNdjson, type StoredResult } from "../lib/reconstruct";
import { parseReplay, REPLAYS_DIR } from "../lib/replay";

/**
 * Writes replays/<scenario>.reconstructed.ndjson for every scenario with stored benchmark results, from the first
 * correct agent run. Reads evals/results/ and evals/scenarios.json only; never changes them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = path.resolve(here, "../../../evals");

const scenarios = JSON.parse(await readFile(path.join(EVALS_DIR, "scenarios.json"), "utf8")) as {
  scenarios: { id: string; alert: string; fixture?: boolean }[];
};
const alerts = new Map(scenarios.scenarios.filter((s) => !s.fixture).map((s) => [s.id, s.alert]));

const files = (await readdir(path.join(EVALS_DIR, "results"))).filter((f) => f.endsWith(".json")).sort();
for (const f of files) {
  const result = JSON.parse(await readFile(path.join(EVALS_DIR, "results", f), "utf8")) as StoredResult;
  const alert = alerts.get(result.id);
  const run = pickRun(result);
  if (!alert || !run) {
    console.log(`skip ${f}: ${!alert ? "not a benchmark scenario" : "no correct agent run"}`);
    continue;
  }
  const text = toNdjson(reconstruct(result, run, alert));
  parseReplay(text); // never write a file the server would reject
  const out = path.join(REPLAYS_DIR, `${result.id}.reconstructed.ndjson`);
  await writeFile(out, text);
  console.log(`wrote ${path.relative(process.cwd(), out)} (agent run ${run.run}, ${text.trim().split("\n").length} events)`);
}
