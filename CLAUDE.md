# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project

IncidentLens: an autonomous agent that diagnoses distributed system failures by calling
real diagnostic tools (via a custom MCP server) instead of relying on raw log dumps,
with verified citations and a measured benchmark against a naive baseline.

Full phase plan lives in `build-order.md`. Always check which phase is currently active
before doing any work — do not implement later phases early, even if it seems convenient.

**Current phase: Phase 4 Naive baseline + first benchmark.**

## Workflow Rules

- Always propose a plan before creating or editing files. Wait for explicit confirmation
  before writing anything to disk.
- Work phase by phase, per `build-order.md`. Do not start the next phase's work until the
  current phase's Definition of Done has been manually verified by me.
- When a command fails or a test doesn't pass, read the actual error output first. Do not
  guess at a fix before seeing the real error.
- Never run destructive commands (`docker system prune`, `rm -rf`, any `DROP`/`TRUNCATE`
  SQL, force-pushing git) without explicit confirmation first, regardless of context.

## Commands

```bash
# Start the sandbox
cd sandbox && docker compose up --build

# Stop and remove containers
cd sandbox && docker compose down

# Reset a single service after a chaos scenario
docker compose restart order-service

# Run a chaos scenario
./sandbox/chaos/scenario-db-exhaustion.sh
```

## Tech Stack

- Node.js (v20 LTS), TypeScript
- Docker / Docker Compose
- PostgreSQL (via the `pg` package, no ORM at this stage)
- Claude API (tool use, MCP, extended thinking, prompt caching) — from Phase 3 onward

## Architecture (Phase 1 scope only)

```
sandbox/
  docker-compose.yml
  services/
    gateway/        — reverse proxy, 3s timeout to order-service
    order-service/  — Express API, Postgres pool (max 10 connections)
  chaos/
    scenario-db-exhaustion.sh
```

`order-service` intentionally includes one buggy endpoint that acquires a database
connection and never releases it back to the pool. This is the deliberate bug the chaos
script exploits — it is not a mistake to "fix" unless a later phase explicitly says so.

## Definition of Done — Phase 1

`docker compose up`, run the chaos script, then request the gateway's healthy endpoint
and see a real `504 Gateway Timeout`. The failure must be reproducible on demand and
resettable with `docker compose restart order-service`.