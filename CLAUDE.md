# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project

IncidentLens: an autonomous agent that diagnoses distributed system failures by calling
real diagnostic tools (via a custom MCP server) instead of relying on raw log dumps,
with verified citations and a measured benchmark against a naive baseline.

Full phase plan lives in `build-order.md`. Always check which phase is currently active
before doing any work — do not implement later phases early, even if it seems convenient.

**Current phase: Phase 7**

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
# Sandbox
cd sandbox && docker compose up --build
cd sandbox && docker compose down
docker compose restart order-service      # reset after a chaos scenario

# Chaos scenarios (see sandbox/chaos/)
./sandbox/chaos/scenario-db-exhaustion.sh
# (add the memory-leak and corrupt-deploy script names here)

# Benchmark and tests (from evals/)
npm run bench -- --scenario <id> --runs <N>
npm test
```

## Architecture

```
sandbox/            Docker Compose: gateway, order-service, postgres, storefront
  chaos/            trigger/reset scripts per scenario
  deploy-history/   generator + patches; output in .deploy-history/ (gitignored)
packages/
  mcp-server/       read-only telemetry tools (logs, stats, git history, topology)
  agent/            tool loop, Zod report schema, citation verifier
evals/              baseline, grader, scenarios.json, benchmark runner, results/
```

The sandbox bugs are deliberate: the pool leak (`/orders/leaky`), the idempotency
cache without eviction, and the break patch in `deploy-history/patches/break/`.
Do not "fix" them.

## Protected — do not modify

- Scenarios 1–3 and their grading criteria in `evals/scenarios.json`
- Existing tests in `evals/grader.test.ts` (adding tests is fine, weakening is not)
- `packages/mcp-server/src/docker.ts` (read-only guarantee; only list/inspect/logs/stats)
- Never commit `.env` files or `sandbox/.deploy-history/`

## Definition of Done — Phase 7

(Copy from build-order.md Phase 7.)