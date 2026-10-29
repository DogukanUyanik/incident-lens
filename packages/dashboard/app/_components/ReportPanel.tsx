"use client";

import { useState } from "react";
import type { RunEvent } from "../../lib/events";
import { citationsOf, splitAround, type Citation } from "../_client/citations";

function CitationItem({
  c,
  open,
  onToggle,
}: {
  c: Citation;
  open: boolean;
  onToggle: () => void;
}) {
  const parts = c.result ? splitAround(c.result.text, c.quote) : null;
  return (
    <li className={`citation${open ? " open" : ""}`}>
      <button className="citation-head" onClick={onToggle} aria-expanded={open}>
        <span className={`badge ${c.verified ? "badge-ok" : "badge-bad"}`}>{c.verified ? "✔ verified" : "✘ not verified"}</span>
        <code>{c.tool}</code>
        {c.container && <span className="container">{c.container}</span>}
        <span className="quote-preview">“{c.quote}”</span>
      </button>
      {open && (
        <div className="citation-body">
          <dl>
            <dt>Tool</dt>
            <dd>
              <code>{c.tool}</code>
            </dd>
            <dt>Container</dt>
            <dd>{c.container ?? <span className="muted">—</span>}</dd>
            <dt>Verified</dt>
            <dd>
              {c.verified ? "yes: the quote is an exact substring of that tool call's output" : `no${c.reason ? `: ${c.reason}` : ""}`}
            </dd>
            <dt>Found in</dt>
            <dd>
              <code className="args">{c.label}</code>
              {c.sourceMismatch && <div className="muted">The report named a different call than the one the quote was found in.</div>}
            </dd>
            <dt>Quoted text</dt>
            <dd>
              <pre className="quote">{c.quote}</pre>
            </dd>
          </dl>
          {c.result && (
            <>
              <div className="label">
                Tool result{c.result.truncated && <span className="badge badge-warn">truncated at 4000 chars</span>}
              </div>
              <pre className="tool-output">
                {parts ? (
                  <>
                    {parts[0]}
                    <mark>{parts[1]}</mark>
                    {parts[2]}
                  </>
                ) : (
                  c.result.text
                )}
              </pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function ReportPanel({
  events,
  onCite,
}: {
  events: RunEvent[];
  /** Called with the citation's call label, so the event stream can highlight that call. */
  onCite: (label: string | null) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const final = [...events].reverse().find((e) => e.type === "report_final");
  const end = events.at(-1)?.type === "run_end" ? events.at(-1) : undefined;

  if (!final || final.type !== "report_final") {
    return (
      <div className="empty">
        {end && end.type === "run_end" && !end.ok
          ? `No report: the run failed (${end.failure ?? "unknown reason"}).`
          : "The final report appears here when the run submits a verified report."}
      </div>
    );
  }
  const citations = citationsOf(events);
  const toggle = (i: number) => {
    const next = open === i ? null : i;
    setOpen(next);
    onCite(next === null ? null : citations[i].label);
  };
  return (
    <div className="report">
      <h3>Summary</h3>
      <p>{final.report.summary}</p>
      <h3>Root cause</h3>
      <p>{final.report.root_cause}</p>
      <h3>
        Evidence <span className="muted">({citations.filter((c) => c.verified).length}/{citations.length} verified; click to open)</span>
      </h3>
      <ul className="citations">
        {citations.map((c, i) => (
          <CitationItem key={i} c={c} open={open === i} onToggle={() => toggle(i)} />
        ))}
      </ul>
      {!citations.some((c) => c.result) && (
        <p className="muted small">Tool output was not recorded for this run, so citations show the quote and where it was verified.</p>
      )}
    </div>
  );
}
