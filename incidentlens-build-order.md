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

## Phase 7 — Extended thinking, measured

**Build:** turn on thinking for the reasoning step. Handle the signature/thinking-block requirement in the tool loop (verify current API docs for your chosen model — don't assume the old spec's details still hold).

**Definition of Done:** re-run the Phase 5 benchmark with thinking on vs. off. You have a real answer to "did this actually help," not an assumption.

---

## Phase 8 — Prompt caching, measured

**Build:** cache breakpoints on the system prompt and tool definitions.

**Definition of Done:** run the agent twice in the same hour, log `cache_read_input_tokens` vs `cache_creation_input_tokens`, and report the real numbers — not an estimated percentage.

---

## Phase 9 — RAG experiment (the honest version)

**Build:** the runbooks/post-mortems corpus. Two versions to compare: (a) all documents dumped into a cached context block, (b) the hybrid BM25 + dense + RRF pipeline.

**Definition of Done:** re-run the benchmark once with (a), once with (b). Report whichever one actually wins on your real corpus size — this is the "RAG paradox" experiment, and the result is valuable either way.

---

## Phase 10 — SSE + dashboard, as a shell over what already works

**Build:** the Next.js dashboard, event stream, chaos trigger buttons — a visual layer over a backend that's already fully working and already benchmarked.

**Definition of Done:** trigger a failure from the UI, watch the agent's reasoning stream live, see the final report with clickable citations.

---

## Phase 11 — Docker packaging + README

**Build:** `docker-compose.demo.yml` for one-command startup. README with: architecture diagram, benchmark results (real numbers from Phases 4–9), the honest scope note (scenarios were self-authored, plus whatever Phase 6 showed), and the RAG experiment's actual outcome.

**Security hardening (do this before this phase counts as done):** the Phase 2 MCP server talks directly to `/var/run/docker.sock`, which is effectively root-equivalent access — "read-only" up to now has only been enforced by the server's own code (it simply chooses not to call destructive Docker API methods), not by anything structural. That was an acceptable, deliberate trade-off while everything ran locally, single-user, over stdio. It stops being acceptable once this is containerized or exposed beyond your own machine. Put a `docker-socket-proxy` (e.g. `tecnativa/docker-socket-proxy`, with only `CONTAINERS=1` enabled) between the MCP server and the socket, so read-only is enforced at the network/proxy level, not just by code convention. Verify it by confirming a destructive call (e.g. a container stop) genuinely fails through the proxy, not just that your own tools happen not to send one.

**Definition of Done:** someone else can clone the repo, run one command, and see the whole thing work. The MCP server's Docker access goes through the socket proxy, not the raw socket, and this is verified, not assumed.
---

## What changed vs. the original phase order

Nothing was cut. Phases 1–3 now front-load the parts that make the whole system provably work (sandbox → tools → agent loop → citations) before any optimization layer gets added. Everything from Phase 4 onward is additive — each one has its own measurable "did this help" test, so you're never trusting an unmeasured claim, and you always have a working, demoable system at every stopping point.
