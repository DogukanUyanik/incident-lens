# IncidentLens agent (Phase 3)

CLI agent that investigates an alert against the Phase 1 sandbox. It spawns the Phase 2 telemetry MCP server
(`packages/mcp-server`) over stdio, runs a tool-use loop with Claude (max 10 turns), and finishes only when it
submits a report through the `submit_report` tool whose evidence quotes all verify as exact substrings of tool
output seen during the run.

## Run

```bash
cd sandbox && docker compose up -d && cd ..
./sandbox/chaos/scenario-db-exhaustion.sh          # exhaust the pool (expect a 504)

cd packages/agent && npm install
export ANTHROPIC_API_KEY=...                        # or `ant auth login`
npm start                                           # default alert: gateway 504s on /orders
npm start -- "users report checkout hanging"       # custom alert

docker compose -f ../../sandbox/docker-compose.yml restart order-service   # reset afterwards
```

Exit code is 0 for a verified report, 1 otherwise.

## Configuration

| Env var | Default | |
|---|---|---|
| `INCIDENTLENS_MODEL` | `claude-sonnet-5-5` | Thinking is turned off (`between_tools`) only on this model; other models run their default thinking. |
| `MCP_SERVER_DIR` | `../mcp-server` | Directory of the telemetry MCP server package. |

## Citation verification

Every tool result's exact text (what the model saw) is recorded. On `submit_report`, each `verbatim_quote` must be
a literal, case-sensitive substring of a non-error tool result from this run and at least 12 characters long.
Any failure rejects the report with an `is_error` tool result naming the bad quotes, and the agent retries within
the remaining turns. `source` is not enforced; a quote found outside the call its `source` names is only flagged.
