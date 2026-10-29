"use client";

import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "../../lib/events";
import { callLabel } from "../_client/citations";

const fmtInt = (n: number) => n.toLocaleString("en-US");

function ToolResult({ e }: { e: Extract<RunEvent, { type: "tool_result" }> }) {
  const [open, setOpen] = useState(false);
  const lines = e.text.split("\n").length;
  return (
    <div className={`ev ev-result${e.is_error ? " ev-error" : ""}`}>
      <button className="linklike" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "▾" : "▸"} result of {e.name} · {fmtInt(lines)} lines
      </button>
      {e.truncated && <span className="badge badge-warn">truncated at 4000 chars</span>}
      {e.is_error && <span className="badge badge-bad">error</span>}
      {open && <pre className="tool-output">{e.text}</pre>}
    </div>
  );
}

function Event({ e, highlighted }: { e: RunEvent; highlighted: string | null }) {
  switch (e.type) {
    case "run_start":
      return (
        <div className="ev ev-start">
          <div>
            <strong>Run started</strong> · {e.scenario_id} · model <code>{e.model}</code>{" "}
            {e.source === "reconstructed" ? (
              <span className="badge badge-recon">reconstructed</span>
            ) : (
              <span className="badge badge-live">{e.mode === "live" ? "live" : "recorded live run"}</span>
            )}
          </div>
          <div className="muted">Alert: {e.alert}</div>
          {e.note && <div className="note">{e.note}</div>}
        </div>
      );
    case "turn_start":
      return (
        <div className="ev-turn">
          Turn {e.turn} <span className="muted">of max {e.max_turns}</span>
        </div>
      );
    case "assistant_text":
      return <div className="ev ev-text">{e.text}</div>;
    case "thinking":
      return (
        <div className="ev ev-note">
          <span className="label">progress note</span>
          {e.text ? <span>{e.text}</span> : <span className="muted">(no text returned · {e.chars} chars)</span>}
        </div>
      );
    case "retry":
      return <div className="ev ev-warn">Turn {e.turn} hit max_tokens; the same request was sent once more.</div>;
    case "tool_call": {
      const label = e.args ? callLabel(e.name, e.args) : null;
      const isCited = label !== null && label === highlighted;
      return (
        <div className={`ev ev-call${isCited ? " ev-cited" : ""}`} data-label={label ?? undefined}>
          <span className="arrow">→</span> <code>{e.name}</code>{" "}
          {e.args ? (
            <code className="args">{JSON.stringify(e.args)}</code>
          ) : (
            <span className="muted">(arguments not recorded)</span>
          )}
        </div>
      );
    }
    case "tool_result":
      return <ToolResult e={e} />;
    case "report_submitted":
      return <div className="ev ev-report">Report submitted (turn {e.turn}).</div>;
    case "verification":
      return (
        <div className={`ev ${e.ok ? "ev-ok" : "ev-bad"}`}>
          {e.ok ? "✔" : "✘"} Citations {e.ok ? "verified" : "rejected"}:{" "}
          {e.checks.filter((c) => c.ok).length}/{e.checks.length} quotes found in tool output
          {e.reason && ` · ${e.reason}`}
        </div>
      );
    case "report_final":
      return <div className="ev ev-ok">Report accepted after {e.turns} turns.</div>;
    case "error":
      return (
        <div className="ev ev-bad">
          <strong>Error ({e.stage}):</strong> {e.message}
        </div>
      );
    case "run_end":
      return (
        <div className={`ev ev-end ${e.ok ? "ev-ok" : "ev-bad"}`}>
          <strong>Run {e.ok ? "finished" : "failed"}</strong>
          {e.failure && ` · ${e.failure}`} · turns {e.turns ?? "—"} · tokens{" "}
          {e.usage ? `${fmtInt(e.usage.input_tokens)} in / ${fmtInt(e.usage.output_tokens)} out` : "—"} · time{" "}
          {e.seconds !== null ? `${e.seconds.toFixed(1)}s` : "—"}
        </div>
      );
  }
}

export function EventStream({
  events,
  streaming,
  highlighted,
}: {
  events: RunEvent[];
  streaming: boolean;
  highlighted: string | null;
}) {
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streaming) end.current?.scrollIntoView({ block: "nearest" });
  }, [events.length, streaming]);
  useEffect(() => {
    if (!highlighted) return;
    const el = [...(box.current?.querySelectorAll<HTMLElement>("[data-label]") ?? [])].find(
      (x) => x.dataset.label === highlighted
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);

  if (events.length === 0) {
    return <div className="empty">Pick a scenario and press Play (replay) or Run live. Events appear here as they stream.</div>;
  }
  return (
    <div className="stream" ref={box} aria-live="polite">
      {events.map((e) => (
        <Event key={`${e.run_id}-${e.seq}`} e={e} highlighted={highlighted} />
      ))}
      {streaming && <div className="ev muted pulse">streaming…</div>}
      <div ref={end} />
    </div>
  );
}
