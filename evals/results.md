# IncidentLens benchmark — agent vs naive baseline

- **Generated:** 2026-10-05T22:11:37.470Z
- **Model requested:** `claude-sonnet-5-5`; **served:** `claude-sonnet-5-5`
- **3 self-authored scenarios** (written by the author of the agent); not a general result. Each scenario was run separately; its run date is in its section.
- Both approaches reach the same sources through the same MCP tools (logs, stats, topology, deploy history), each capped at 4000 chars per call. The baseline gets all of it in one prompt (every container's logs at tail=1000 and stats, the topology, and every commit of every deploy history); the agent fetches what it chooses.
- `memory-leak-oom`: Docker clears OOMKilled/ExitCode when the restart policy restarts a container, so the OOM is only inferable (restart count, uptime, memory vs limit, repeated startup lines), not shown directly.
- `db-pool-exhaustion` uses the same grading criteria as Phase 4, but its inputs differ: both approaches now also see topology and deploy history, and the reset clears gateway/order-service logs (Phase 4 runs saw stale lines).
- Grading is a code-based keyword heuristic per scenario (`evals/scenarios.json` → `grading`): correct iff every keyword group matches, with whole-word negation. Check the root causes below by eye.

## Combined summary

| Scenario | Approach | Accuracy | Mean tokens | Mean time | Citation validity | Failed | Mean turns |
|---|---|---|---|---|---|---|---|
| db-pool-exhaustion | — | not run | | | | | |
| memory-leak-oom | agent | 1/2 | 46,960 (in 45,392 / out 1,568) | 22.9s | 100% (2/2 runs had a report) — by construction | 0/2 | 6.0 |
| memory-leak-oom | baseline | 1/2 | 14,666 (in 13,964 / out 702) | 13.0s | 100% (2/2 runs had a report) | 0/2 | 1 call |
| corrupt-deploy | agent | 2/2 | 19,518 (in 18,416 / out 1,102) | 15.5s | 100% (2/2 runs had a report) — by construction | 0/2 | 4.0 |
| corrupt-deploy | baseline | 2/2 | 14,305 (in 13,657 / out 648) | 10.4s | 100% (2/2 runs had a report) | 0/2 | 1 call |
| **all run scenarios** | agent | **3/4** | | | | | |
| **all run scenarios** | baseline | **3/4** | | | | | |

## Database connection pool exhaustion (`db-pool-exhaustion`)

_Not run yet._

## Memory leak with repeated OOM kills (`memory-leak-oom`)

- **Run:** 2026-10-05T22:10:25.628Z → 2026-10-05T22:11:37.424Z, N=2, model `claude-sonnet-5-5`
- **Alert:** "the gateway is intermittently returning 502 Bad Gateway on /orders"
- **Ground truth:** order-service leaks memory: its Idempotency-Key replay cache (src/idempotency.ts) keeps every request body and response in a module-level Map with no TTL or eviction. Under storefront's steady bulk-order traffic its memory grows until it reaches the 160 MiB container limit and the kernel OOM-kills it (exit 137); the on-failure restart policy restarts it, and the cycle repeats roughly every 90s. Requests during each restart fail with 502 at the gateway. Known evidence limit: Docker clears OOMKilled/ExitCode when the restart policy restarts the container, so the tools show the OOM only indirectly (restartCount climbing, uptime resetting, memory approaching memoryLimitMiB, repeated startup lines in the logs).
- **Log cap:** the 4000-char cap truncated the logs of: gateway, postgres (baseline collections).

| Metric | Agent | Baseline |
|---|---|---|
| Accuracy | 1/2 | 1/2 |
| Mean tokens (input + output) | 46,960 (in 45,392 / out 1,568) | 14,666 (in 13,964 / out 702) |
| Mean wall-clock time | 22.9s | 13.0s |
| Citation validity (mean) | 100% (2/2 runs had a report) — by construction | 100% (2/2 runs had a report) |
| Failed runs (no usable report) | 0/2 | 0/2 |
| Mean turns | 6.0 | 1 call |

| Approach | Run | Verdict | Grader signals | Tokens | Time | Citations | Root cause / failure |
|---|---|---|---|---|---|---|---|
| agent | 1 | wrong | memory✔ growth✔ oom✘ loc✔ | 33,617 | 20.0s | 5/5 | Commit f9824ea ("Support Idempotency-Key on order creation") added an in-process idempotency cache (`const responses = new Map<string, StoredResponse>()`) in order-service. It is never evicted, expired or size-bounded. Each stored entry holds the response body and also the full raw request buffer (`request: req.rawBody`, captured via express.json `verify`, up to 1mb per request). Memory grows without bound under steady POST /orders traffic until the container hits its 160 MiB limit and restarts (restartCount 2, repeated "listening on 4000" lines). The gateway returns 502 whenever the upstream order-service is down or restarting. |
| baseline | 1 | wrong | memory✔ growth✔ oom✘ loc✔ | 14,474 | 12.5s | 6/6 | order-service has a memory leak that exhausts its 160 MiB limit and causes it to restart. The leak comes from the Idempotency-Key middleware added in commit f9824ea, which keeps every response in an unbounded in-memory Map with no eviction or TTL. For each key it also holds the full raw request body (`request: req.rawBody`). Memory grows with every order that carries an Idempotency-Key until the container hits its cap and is restarted. During each restart the gateway has no upstream to reach, so requests get 502. The storefront 502 bursts line up with the restarts at 22:08:08 and 22:09:45. |
| agent | 2 | correct | memory✔ growth✔ oom✔ loc✔ | 60,302 | 25.8s | 6/6 | Commit f9824ea ("Support Idempotency-Key on order creation") added src/idempotency.ts, which stores every response in a module-level Map keyed by Idempotency-Key. The map is never evicted, has no TTL and no size cap. Each entry also keeps the full raw request body (`request: req.rawBody`), which the same commit began capturing via express.json's `verify` hook. Under sustained POST /orders traffic, heap usage grows without bound until the container reaches its 160 MiB memory limit and is restarted. While order-service is down or restarting, the gateway cannot reach it and returns 502 to clients. The 502s are therefore a symptom of order-service restarts. The underlying defect is the unbounded in-memory idempotency cache. |
| baseline | 2 | correct | memory✔ growth✔ oom✔ neg×1 loc✔ | 14,858 | 13.5s | 7/7 | order-service is being crash-restarted roughly every 97 seconds. The container has a 160 MiB memory limit and sits at ~79 MiB (49%) just 2 seconds after the latest start, which suggests a memory leak or unbounded growth is driving it to the limit, though no OOM kill is recorded in the stats. The prime suspect is the idempotency middleware from commit f9824ea. It stores every response in a module-level Map (`responses`) that is never evicted. Each entry also retains the full raw request buffer (`rawBody`), and the keys are per-request Idempotency-Keys. Memory therefore grows with every order until the 160 MiB limit kills the process, which Docker then restarts. While the process is down or starting, the gateway's fetch to order-service fails and surfaces as 502. This causal chain is inferred from the code and the restart pattern, not directly confirmed by a crash log. |

## Corrupt deploy breaking payload parsing (`corrupt-deploy`)

- **Run:** 2026-10-05T22:03:16.321Z → 2026-10-05T22:04:08.145Z, N=2, model `claude-sonnet-5-5`
- **Alert:** "the gateway is returning 500 Internal Server Error on POST /orders"
- **Ground truth:** A recent order-service deploy broke order payload parsing. The newest commit in its deploy history, "Refactor order payload parsing" (minutes before the errors began), changed src/payload.ts to read each line's price as a Money object (price.amount, price.currency.toUpperCase()), while clients still send price as a number. Every POST /orders now throws TypeError: Cannot read properties of undefined (reading 'toUpperCase') in normalizeMoney/normalizeLine and returns 500 immediately. GET /orders and the database are unaffected.
- **Log cap:** the 4000-char cap truncated the logs of: order-service, postgres (baseline collections).

| Metric | Agent | Baseline |
|---|---|---|
| Accuracy | 2/2 | 2/2 |
| Mean tokens (input + output) | 19,518 (in 18,416 / out 1,102) | 14,305 (in 13,657 / out 648) |
| Mean wall-clock time | 15.5s | 10.4s |
| Citation validity (mean) | 100% (2/2 runs had a report) — by construction | 100% (2/2 runs had a report) |
| Failed runs (no usable report) | 0/2 | 0/2 |
| Mean turns | 4.0 | 1 call |

| Approach | Run | Verdict | Grader signals | Tokens | Time | Citations | Root cause / failure |
|---|---|---|---|---|---|---|---|
| agent | 1 | correct | change✔ payload✔ loc✔ | 19,536 | 17.8s | 5/5 | Commit 8897f05 "Refactor order payload parsing" (order-service, src/payload.ts) changed the expected shape of a line item's `price` from a plain number to a Money object `{amount, currency}`. The new `normalizeMoney` calls `price.currency.toUpperCase()` without validating the input. Clients still send the old payload format (numeric price, no currency), and the check for a numeric price was removed, so any such request reaches `normalizeMoney` with `currency` undefined and crashes with an unhandled TypeError. Express turns that into a 500, and the gateway returns the 500 to the caller. The refactor is a breaking API change with no backward compatibility and no validation of the currency field. It also dropped the order-level `currency` field that clients may send. Postgres and the gateway itself are healthy. |
| baseline | 1 | correct | change✔ payload✔ loc✔ | 14,338 | 10.1s | 5/5 | Commit 8897f05 "Refactor order payload parsing" changed normalizeLine to expect price as a Money object ({amount, currency}) instead of a plain number, and added normalizeMoney, which calls price.currency.toUpperCase(). Existing clients (and the README contract) still send price as a number such as 9.99 with a top-level currency field. For such payloads price.currency is undefined, so toUpperCase() throws an unhandled TypeError (not a PayloadError), which surfaces as a 500. The refactor is a breaking, unvalidated API contract change with no backward compatibility and no input validation of the price shape. |
| agent | 2 | correct | change✔ payload✔ loc✔ | 19,499 | 13.2s | 5/5 | Commit 8897f05 "Refactor order payload parsing" (src/payload.ts) changed the line `price` from a plain number to a Money object ({amount, currency}). The new normalizeMoney() calls price.currency.toUpperCase() without validating the shape. The old validation (price must be a non-negative number) was replaced by a check that only rejects undefined/null. Clients still send numeric prices (or prices with no currency), so price.currency is undefined and the code throws an unhandled TypeError. This surfaces as a 500 instead of a 400 validation error. The refactor was a breaking change to the request contract, and it also dropped the top-level `currency` field and its EUR default. |
| baseline | 2 | correct | change✔ payload✔ loc✔ | 14,271 | 10.7s | 5/5 | Commit 8897f05 ('Refactor order payload parsing') changed normalizeLine to expect each line item's price to be a Money object ({amount, currency}) and call price.currency.toUpperCase(). Clients (and the README contract) still send price as a plain number, e.g. 9.99, so price.currency is undefined and the call throws a TypeError. The refactor also dropped the top-level currency field handling and has no validation or backward compatibility for the old payload shape. PayloadError is not raised for this case, so the failure surfaces as an unhandled 500 rather than a 400. Postgres and the gateway are healthy; this is a breaking change in order-service's request parsing. |
