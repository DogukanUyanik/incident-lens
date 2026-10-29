"use client";

import { useEffect, useRef } from "react";
import type { ScriptRun } from "../_client/types";

export function ScriptPanel({ run }: { run: ScriptRun | null }) {
  const end = useRef<HTMLDivElement>(null);
  // Block body: an effect's return value is called as its cleanup, and scrollIntoView may return a value.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [run?.lines.length]);
  if (!run) return <div className="empty small">Trigger and reset output appears here.</div>;
  return (
    <div className="script">
      <div className="script-head">
        <strong>{run.kind === "trigger" ? "Trigger" : "Reset"}</strong> · {run.scenario_id} ·{" "}
        {run.end ? (
          <span className={`badge ${run.end.ok ? "badge-ok" : "badge-bad"}`}>
            {run.end.ok ? "done" : "failed"} · exit {run.end.exit_code ?? "—"} · {run.end.seconds}s
          </span>
        ) : (
          <span className="badge badge-live pulse">running</span>
        )}
      </div>
      <pre className="script-log">
        {run.lines.join("\n")}
        {run.end?.error && `\n${run.end.error}`}
      </pre>
      <div ref={end} />
    </div>
  );
}
