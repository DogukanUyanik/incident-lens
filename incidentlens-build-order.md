# IncidentLens — Build Order (Working Thing After Every Phase)

Same components as the original spec. Reordered so each phase ends with something you can actually run and show, not a half-wired system. The "Core" line marks where the project is honestly finished — everything after that is a bonus layer, not a requirement.

Each phase has a **Definition of Done**: a concrete test you run yourself to confirm the phase actually works, before moving on.

---

## Phase 1 — Sandbox + one real failure

**Build:** `docker-compose.yml` with gateway, order-service, postgres. One chaos script: `scenario-db-exhaustion.sh`.

**Definition of Done:** `docker compose up`, run the chaos script, then `curl` the gateway and see a real 504. You can reproduce the failure on demand and reset it.

---

## Phase 2 — Telemetry MCP server, 2 tools only

**Build:** `get_container_logs`, `get_container_stats`. Nothing else yet — no git history, no topology tool.

**Definition of Done:** Open the MCP Inspector, call both tools by hand against the running sandbox, and see real log lines / real CPU-memory numbers come back. No Claude involved yet — just proving the server itself works.

---

## Phase 3 — Agent core, CLI only, no RAG, no thinking

**Build:** the multi-turn tool loop (`stop_reason == "tool_use"`), MCP client wired to Phase 2's server, Zod schema for the incident report, the citation verifier.

**Definition of Done:** run the agent from the CLI against the Phase 1 failure. It correctly names the database connection leak as the cause, every citation in its report is verified against real tool output, and it stops on its own with a valid report. This is the first point where the whole spine — Claude, tools, structured output, citations — works end to end.

---

## Core finish line

If you stopped here, you have a complete, honest, working project: a real failure, a real agent that diagnoses it correctly, with verified citations. Everything below is a genuine improvement, not a missing piece.

---

## Phase 4 — Naive baseline + first benchmark

**Build:** a second, deliberately simple approach — dump raw logs into a prompt, ask for the cause, no tools. `evals/run-benchmark.ts` comparing it against Phase 3's agent on the one scenario you have.

**Definition of Done:** a results table (accuracy, tokens, time) showing agent vs. baseline on scenario 1. Even with one scenario, you now have your first real, measured claim instead of an assumption.

---

## Phase 5 — Two more scenarios + real eval dataset

**Build:** `scenario-memory-leak.sh`, `scenario-corrupt-deploy.sh`. Expand `scenarios.json` to 3 ground-truth cases. Add `inspect_git_history` and `get_cluster_topology` tools (needed for the corrupt-deploy scenario).

**Definition of Done:** the benchmark from Phase 4 now runs across all 3 scenarios, agent vs. baseline, with a results table for each.

---

## Phase 6 — Ground truth check (the credibility fix)

**Build:** nothing new. Either (a) write a 4th scenario without looking at it again until test time, or (b) find a documented open-source bug with a known root cause and reproduce it.

**Definition of Done:** the agent's diagnosis matches the independently-known answer, and you've written down the result — pass or fail, honestly — for your README.

---

## Phase 7 — Extended thinking, measured — DEFERRED (cost)

**Build:** a `--thinking off|on` switch, results stored separately per setting.

**Definition of Done:** the same scenarios with thinking off vs. on, with the decision rule fixed before measuring ("helps" = ON ≥ OFF + 2 correct runs of 20).

**Status:** planned and designed, not run (about $7 of API spend). On Sonnet 5.5 "off" is `between_tools`, the lowest setting, not literally no thinking.

---

## Phase 8 — Prompt caching, measured — PLANNED (after Phase 11)

**Build:** cache breakpoints on the system prompt and tool definitions.

**Definition of Done:** run the agent twice in the same hour, log `cache_read_input_tokens` vs `cache_creation_input_tokens`, and report the real numbers, not an estimated percentage. Keep it to 2-3 runs on one scenario.

---

## Phase 9 — RAG experiment — DEFERRED (cost, and a self-written corpus is weak evidence)

**Original plan:** runbooks/post-mortems corpus; (a) everything in a cached context block vs. (b) BM25 + dense + RRF.

**Cheap variant, if budget allows:** measure retrieval only, without the model. For a set of queries ("prometheus keeps restarting"), does the right runbook appear in the top 3? Compare BM25 alone vs. hybrid, using a local embedding model ($0 API cost). Then run the agent once or twice with the retrieved documents.

**Caveat to state in the README:** the corpus is self-written, so retrieval is artificially easy. The full benchmark comparison was not run.

---

## Phase 10 — SSE + dashboard, replay-first — NEXT

**Build:** Next.js dashboard, event stream, chaos trigger buttons, as a shell over the working backend. One fixed event schema shared by two modes: **Replay** (default, events from a saved run, costs nothing) and **Live** (real agent run, off unless `ALLOW_LIVE=true`, rate-limited to one run per minute, every live run saves its events as a new replay file). Trigger/reset buttons only run scenarios from `scenarios.json` by id.

**Definition of Done:** trigger a failure from the UI, watch the agent's reasoning stream (replay or live), see the final report with clickable citations (tool, container, verified yes/no). Built and tested without API calls; one live run as the final check.

---

## Phase 11 — Docker packaging + README

**Build:** `docker-compose.demo.yml` for one-command startup. README with architecture diagram, real benchmark results (Phases 4 to 6, plus 8 if done), the honest scope note, and what was skipped or deferred (7, 9).

**Security hardening (do this before this phase counts as done):** the MCP server talks directly to `/var/run/docker.sock`, which is effectively root-equivalent. "Read-only" has only been enforced by the server's own code. Put a `docker-socket-proxy` (`tecnativa/docker-socket-proxy`, only `CONTAINERS=1`) between the MCP server and the socket. Verify that a destructive call (e.g. a container stop) genuinely fails through the proxy.

**Definition of Done:** someone else can clone the repo, run one command, and see the whole thing work, with Docker access going through the proxy, verified and not assumed.

---

## Order from here

10 → 11 → 8 → (9, cheap variant) → (7, if budget appears)