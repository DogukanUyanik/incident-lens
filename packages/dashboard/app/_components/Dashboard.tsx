"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunEvent } from "../../lib/events";
import { errorOf, readFrames } from "../_client/sse";
import type { Config, Scenario, ScriptRun } from "../_client/types";
import { EventStream } from "./EventStream";
import { ReportPanel } from "./ReportPanel";
import { ScriptPanel } from "./ScriptPanel";

type Mode = "replay" | "live";

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export function Dashboard() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("replay");
  const [replay, setReplay] = useState<string | null>(null);
  const [speed, setSpeed] = useState(2);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streaming, setStreaming] = useState<Mode | null>(null);
  const [script, setScript] = useState<ScriptRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cited, setCited] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const loadScenarios = useCallback(async () => {
    const res = await fetch("/api/scenarios", { cache: "no-store" });
    if (!res.ok) return setNotice(await errorOf(res));
    const body = (await res.json()) as { scenarios: Scenario[] };
    setScenarios(body.scenarios);
    setSelected((s) => s ?? body.scenarios[0]?.id ?? null);
  }, []);

  const loadConfig = useCallback(async () => {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (res.ok) setConfig((await res.json()) as Config);
  }, []);

  useEffect(() => {
    void loadScenarios();
    void loadConfig();
    const t = setInterval(() => void loadConfig(), 2000);
    return () => clearInterval(t);
  }, [loadScenarios, loadConfig]);

  const scenario = scenarios.find((s) => s.id === selected) ?? null;
  // Newest live recording first, then the reconstructed one.
  const replays = scenario ? [...scenario.replays].sort((a, b) => (a.source === b.source ? b.name.localeCompare(a.name) : a.source === "live" ? -1 : 1)) : [];
  // Pick the newest replay whenever the scenario (or the list, after a live run) changes.
  useEffect(() => {
    setReplay(replays[0]?.name ?? null);
  }, [selected, scenarios]);

  const liveEnabled = config?.live_enabled ?? false;
  useEffect(() => {
    if (!liveEnabled && mode === "live") setMode("replay");
  }, [liveEnabled, mode]);

  const busy = config?.busy ?? null;
  const scriptRunning = script !== null && !script.end;
  const sandboxBusy = busy !== null || scriptRunning || streaming === "live";

  // A run on screen always belongs to the selected scenario: switching stops a replay and clears the stream.
  // A live run is not stopped (it is paid for and saved either way); its replay appears in the list when done.
  function selectScenario(id: string) {
    if (id === selected) return;
    if (streaming !== "live") {
      stop();
      setEvents([]);
      setCited(null);
    }
    setSelected(id);
  }

  function stop() {
    abort.current?.abort();
    abort.current = null;
  }

  async function stream(res: Response, kind: Mode) {
    setStreaming(kind);
    try {
      for await (const f of readFrames(res)) {
        if (f.event === "run_event") setEvents((prev) => [...prev, f.data as RunEvent]);
        else if (f.event === "live_start") setNotice(`Live run started; it is being saved as replay ${(f.data as { replay: string }).replay}.`);
        else if (f.event === "stream_error") setNotice(`Stream error: ${(f.data as { message: string }).message}`);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setNotice(`Stream interrupted: ${(err as Error).message}`);
    } finally {
      setStreaming(null);
    }
  }

  async function play() {
    if (!replay) return;
    stop();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setEvents([]);
    setCited(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/runs/replay?name=${encodeURIComponent(replay)}&speed=${speed}`, { signal: ctrl.signal });
      if (!res.ok) return setNotice(await errorOf(res));
      await stream(res, "replay");
    } catch (err) {
      if ((err as Error).name !== "AbortError") setNotice((err as Error).message);
    }
  }

  async function runLive() {
    if (!scenario) return;
    stop();
    setEvents([]);
    setCited(null);
    setNotice(null);
    const res = await post("/api/runs/live", { scenario_id: scenario.id });
    if (!res.ok) {
      setNotice(`Live run refused: ${await errorOf(res)}`);
      return void loadConfig();
    }
    void loadConfig();
    await stream(res, "live");
    void loadScenarios(); // the new recording is now a replay
    void loadConfig();
  }

  async function runScript(kind: "trigger" | "reset") {
    if (!scenario) return;
    setNotice(null);
    setScript({ kind, scenario_id: scenario.id, lines: [] });
    const res = await post(`/api/scenarios/${encodeURIComponent(scenario.id)}/${kind}`);
    if (!res.ok) {
      const error = await errorOf(res);
      setScript({ kind, scenario_id: scenario.id, lines: [], end: { ok: false, exit_code: null, seconds: 0, error } });
      return void loadConfig();
    }
    void loadConfig();
    for await (const f of readFrames(res)) {
      const d = f.data as { line?: string; ok?: boolean; exit_code?: number | null; seconds?: number; error?: string };
      if (f.event === "script_line") setScript((s) => s && { ...s, lines: [...s.lines, d.line ?? ""] });
      if (f.event === "script_end") {
        setScript((s) => s && { ...s, end: { ok: !!d.ok, exit_code: d.exit_code ?? null, seconds: d.seconds ?? 0, error: d.error } });
      }
    }
    void loadConfig();
  }

  const start = events[0]?.type === "run_start" ? events[0] : null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          IncidentLens <span className="muted">dashboard</span>
        </h1>
        <div className="mode" role="radiogroup" aria-label="Mode">
          <button role="radio" aria-checked={mode === "replay"} className={mode === "replay" ? "on" : ""} onClick={() => setMode("replay")}>
            Replay
          </button>
          <button
            role="radio"
            aria-checked={mode === "live"}
            className={mode === "live" ? "on" : ""}
            disabled={!liveEnabled}
            title={liveEnabled ? "Run the real agent (uses API credit)" : "Live runs are off: the server was started without ALLOW_LIVE=true"}
            onClick={() => setMode("live")}
          >
            Live
          </button>
        </div>
        <div className="status">
          {!liveEnabled && <span className="badge">Live off (ALLOW_LIVE not set)</span>}
          {busy && (
            <span className="badge badge-live pulse">
              sandbox busy: {busy.kind} {busy.scenario_id}
            </span>
          )}
        </div>
      </header>

      <aside className="sidebar">
        <h2>Scenario</h2>
        <ul className="scenarios">
          {scenarios.map((s) => (
            <li key={s.id}>
              <button className={s.id === selected ? "scenario on" : "scenario"} onClick={() => selectScenario(s.id)}>
                <span className="scenario-title">{s.title}</span>
                <span className="scenario-id">{s.id}</span>
              </button>
            </li>
          ))}
        </ul>

        {scenario && (
          <>
            <div className="alert">
              <div className="label">Alert</div>
              {scenario.alert}
            </div>

            <h2>Sandbox</h2>
            <div className="row">
              <button onClick={() => void runScript("trigger")} disabled={sandboxBusy}>
                Trigger
              </button>
              <button onClick={() => void runScript("reset")} disabled={sandboxBusy}>
                Reset
              </button>
            </div>
            <p className="muted small">Runs the scenario&apos;s own chaos script against the local sandbox. No API calls.</p>

            {mode === "replay" ? (
              <>
                <h2>Replay</h2>
                {replays.length === 0 ? (
                  <p className="muted small">No replay for this scenario yet.</p>
                ) : (
                  <>
                    <select value={replay ?? ""} onChange={(e) => setReplay(e.target.value)} aria-label="Replay file">
                      {replays.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.source === "reconstructed" ? "reconstructed" : "live recording"} · {r.name.replace(/^live\//, "")}
                        </option>
                      ))}
                    </select>
                    <div className="row">
                      <label className="small">
                        Speed{" "}
                        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                          {[1, 2, 4, 8].map((x) => (
                            <option key={x} value={x}>
                              {x}×
                            </option>
                          ))}
                        </select>
                      </label>
                      {streaming === "replay" ? (
                        <button onClick={stop}>Stop</button>
                      ) : (
                        <button className="primary" onClick={() => void play()} disabled={!replay}>
                          Play
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <h2>Live run</h2>
                <p className="small warn">Runs the real agent against the sandbox and uses API credit. Trigger the scenario first.</p>
                <button
                  className="primary"
                  onClick={() => void runLive()}
                  disabled={sandboxBusy || (config?.live_retry_after_s ?? 0) > 0}
                >
                  {(config?.live_retry_after_s ?? 0) > 0 ? `Run live (wait ${config!.live_retry_after_s}s)` : "Run live"}
                </button>
              </>
            )}
          </>
        )}

        <h2>Script output</h2>
        <ScriptPanel run={script} />
      </aside>

      <main className="main">
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button className="linklike" onClick={() => setNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
        <section className="panel">
          <h2>
            Event stream{" "}
            {start?.type === "run_start" && start.source === "reconstructed" && <span className="badge badge-recon">reconstructed</span>}
            {streaming && <span className="badge badge-live pulse">{streaming === "live" ? "live" : "replaying"}</span>}
          </h2>
          <EventStream events={events} streaming={streaming !== null} highlighted={cited} />
        </section>
        <section className="panel">
          <h2>Final report</h2>
          <ReportPanel key={events[0]?.run_id ?? "none"} events={events} onCite={setCited} />
        </section>
      </main>
    </div>
  );
}
