/** Shapes of the API responses (lib/handlers.ts), as the browser sees them. */

export interface ReplayRef {
  name: string;
  source: "live" | "reconstructed";
  events: number;
}

export interface Scenario {
  id: string;
  title: string;
  alert: string;
  replays: ReplayRef[];
}

export interface Busy {
  kind: "trigger" | "reset" | "live";
  scenario_id: string;
  since: string;
}

export interface Config {
  live_enabled: boolean;
  live_retry_after_s: number;
  busy: Busy | null;
}

export interface ScriptRun {
  kind: "trigger" | "reset";
  scenario_id: string;
  lines: string[];
  end?: { ok: boolean; exit_code: number | null; seconds: number; error?: string };
}
