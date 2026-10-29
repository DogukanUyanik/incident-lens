/**
 * One thing at a time touches the sandbox: a trigger/reset script or a live run. The lock lives on globalThis so
 * Next.js dev mode, which can load a module more than once, still shares one lock. Assumes one server process.
 */

export interface Activity {
  kind: "trigger" | "reset" | "live";
  scenario_id: string;
  since: string;
}

const KEY = Symbol.for("incidentlens.dashboard.activity");
type Slot = { current: Activity | null };
const slot = ((globalThis as Record<symbol, unknown>)[KEY] ??= { current: null }) as Slot;

export function currentActivity(): Activity | null {
  return slot.current;
}

/** Takes the lock, or returns null when something else holds it. Call the returned function to release it once. */
export function tryAcquire(kind: Activity["kind"], scenario_id: string): (() => void) | null {
  if (slot.current) return null;
  const mine: Activity = { kind, scenario_id, since: new Date().toISOString() };
  slot.current = mine;
  return () => {
    if (slot.current === mine) slot.current = null;
  };
}
