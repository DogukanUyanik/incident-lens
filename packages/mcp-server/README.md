# IncidentLens Telemetry MCP server

Read-only MCP server (stdio) that exposes two tools over the Phase 1 sandbox, via the local Docker socket:

- `get_container_logs` — `{ container, tail? = 100 }` → recent timestamped log lines, capped at 4000 chars (oldest dropped, marked `[TRUNCATED ...]`).
- `get_container_stats` — `{ container }` → CPU %, memory, pids, network I/O, status, startedAt/uptime, restartCount.

`container` is a compose service name (`order-service`, `gateway`, `postgres`). Lookups are scoped to the compose
project `sandbox` (override with `COMPOSE_PROJECT`).

## Run

```bash
cd sandbox && docker compose up --build        # terminal 1
cd packages/mcp-server && npm install
npm run inspect                                 # opens the MCP Inspector connected to this server
```

## Notes

- `restartCount` only counts restart-policy restarts; a manual `docker compose restart` resets `startedAt`/`uptime` instead.
- Access to the Docker socket is root-equivalent. "Read-only" is enforced by this code only; put it behind a
  socket proxy if it is ever containerised or exposed beyond local stdio.
