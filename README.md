# IncidentLens

Work in progress — an autonomous agent that diagnoses distributed-system
failures using real diagnostic tools (MCP) instead of raw log dumps.

Currently working: sandbox with a reproducible bug (Phase 1), a read-only
telemetry MCP server (Phase 2), and an agent that investigates and produces
a citation-verified root-cause report (Phase 3).

Full README with benchmarks and results coming once the core evaluation
phases are complete. See build-order.md for the full plan.

## Results so far

The agent and a naive baseline (all telemetry in one prompt, no tools) were
benchmarked on four scenarios, N=5 each. Three were written by me; one is a
real upstream bug.

| Scenario | Agent | Baseline | Agent cost vs baseline |
|---|---|---|---|
| DB pool exhaustion (own) | 4/5 | 5/5 | ~4.7x tokens |
| Memory leak with OOM kills (own) | 5/5 | 5/5 | ~3.2x tokens |
| Corrupt deploy (own) | 5/5 | 5/5 | ~1.4x tokens |
| Prometheus crash loop on a malformed scrape response (upstream) | 5/5 | 5/5 | ~2.3x tokens |

**Upstream scenario.** Prometheus v3.10.0 crashes when a scrape target serves a
malformed metrics line ([prometheus#18225](https://github.com/prometheus/prometheus/issues/18225),
fixed in [3b44b8b](https://github.com/prometheus/prometheus/commit/3b44b8b463be9291a5605b935a5fbeda88db1366)).
The root cause was confirmed by the maintainers, not by me. The only thing I added
is `metrics-target`, a small nginx container that serves the bad line to trigger the bug.

**What this shows.** On these sandboxes the agent is as accurate as the baseline
but costs more, because all telemetry fits in one prompt. An agent should only pay
off when there is more data than fits in a prompt. I have not tested that yet.

**Limitations.**
- Grading is a keyword heuristic; I read every root cause by hand.
- The scenarios are small, and the baseline sees the same key log lines as the agent.
- One pool-exhaustion agent run failed on `max_tokens`. I then added a per-turn
  trace and one retry (agent and baseline). No retries have occurred since.
- An attempt at a PgBouncer bug was dropped: it needed a custom client and extra
  logging from me, so it would not have been an independent test.