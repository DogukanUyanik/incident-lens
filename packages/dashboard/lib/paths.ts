import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Paths from the working directory, not import.meta.url: inside Next.js's server bundle import.meta.url points into
 * .next/, not at the source file. Both `next dev/start` and `npm test` run from packages/dashboard; anything else
 * fails loudly here instead of reading or running files from the wrong place.
 */
function dashboardDir(): string {
  const dir = process.cwd();
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== "@incidentlens/dashboard") {
    throw new Error(`the dashboard must run from packages/dashboard (working directory is ${dir})`);
  }
  return dir;
}

export const DASHBOARD_DIR = dashboardDir();
export const REPO_ROOT = path.resolve(DASHBOARD_DIR, "../..");
export const REPLAYS_DIR = path.join(DASHBOARD_DIR, "replays");
/** Server-only state that must survive restarts (the live rate limit). Gitignored. */
export const STATE_DIR = path.join(DASHBOARD_DIR, ".state");
