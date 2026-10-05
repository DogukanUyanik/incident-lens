# IncidentLens benchmark — agent vs naive baseline

- **Date:** 2026-10-05T17:05:12.480Z
- **Model requested:** `claude-sonnet-5-5`; **served:** `claude-sonnet-5-5`
- **Runs per approach (N):** 5
- **Alert:** "the gateway is returning 504 Gateway Timeout errors on GET /orders"
- **ONE scenario (db pool exhaustion / order-service connection leak); not a general result.**
- Both approaches see the same 4000-char-per-call log window (the MCP server's cap). In the baseline's collections, the cap truncated the logs of: gateway, order-service, postgres. The baseline gets every container's logs (tail=1000) and stats in one prompt; the agent fetches what it chooses via tools.
- Grading is a code-based keyword heuristic (`evals/grader.ts`): correct = mentions the pool/connections, a non-negated leak / never-released mechanism, and order-service. Check the root causes below by eye.

## Summary

| Metric | Agent | Baseline |
|---|---|---|
| Accuracy | 5/5 | 5/5 |
| Mean tokens (input + output) | 18,012 (in 16,944 / out 1,068) | 8,158 (in 7,706 / out 452) |
| Mean wall-clock time | 13.1s | 9.2s |
| Citation validity (mean) | 100% (5/5 runs had a report) — 100% by construction: the agent's verifier rejects unverified reports | 100% (5/5 runs had a report) |
| Failed runs (no usable report) | 0/5 | 0/5 |
| Mean turns | 3.0 | 1 call |

## Per run

| Approach | Run | Verdict | Grader signals | Tokens | Time | Citations | Root cause / failure |
|---|---|---|---|---|---|---|---|
| agent | 1 | correct | pool✔ leak✔ loc✔ | 17,272 | 10.9s | 4/4 | A code path in order-service (the "orders/leaky" handler) acquires pg pool clients and never releases them. The pool's 10 clients were all held (idle=0) with 5 requests waiting. New /orders requests block on pool acquisition and the gateway times out after ~3s. Postgres is healthy and accepting connections, so the fault is a connection leak in order-service, not a database or gateway failure. |
| baseline | 1 | correct | pool✔ leak✔ loc✔ | 8,166 | 9.3s | 4/4 | A connection leak in order-service's '/orders' handler (the 'orders/leaky' code path): it acquires pg pool clients and never releases them. The pool hit its max (total=10 idle=0) with waiting requests, so new /orders requests block until the gateway's 3s upstream timeout fires and returns 504. This is an application-level pool exhaustion problem, not a Postgres, gateway, or resource issue (no restarts, OOM, or CPU/memory pressure). |
| agent | 2 | correct | pool✔ leak✔ loc✔ | 18,027 | 14.2s | 4/4 | A connection leak in order-service's orders code path (the "orders/leaky" handler). It acquires pg pool clients and deliberately never releases them. The pool reaches its max of 10 with idle=0 and waiting=5, so every later /orders request waits for a client that never frees up. The gateway's 3s proxy timeout then fires and returns a 504. Postgres is healthy (running normally since the 10-05 restart), and the gateway and order-service have not restarted or run out of resources, so the fault is in the application's pool handling. |
| baseline | 2 | correct | pool✔ leak✔ loc✔ | 8,157 | 9.2s | 4/4 | A connection leak in order-service: the 'leaky' orders code path acquires pg pool clients and never releases them. The pool hits its max of 10 clients with 0 idle and requests waiting, so subsequent /orders queries block until the gateway's 3s upstream timeout fires. Postgres itself is healthy (running, accepting connections, low resource use), and the gateway and order-service have no restarts or OOMs, so the fault is the application's failure to release pooled clients. |
| agent | 3 | correct | pool✔ leak✔ loc✔ | 17,911 | 12.8s | 4/4 | A connection leak in order-service's orders handler (the "orders/leaky" code path) acquires pg pool clients and never releases them. The pool hit its max of 10 (idle=0) with 5 requests waiting, so further /orders requests block waiting for a client. The gateway's 3s upstream timeout then fires and it returns 504. Postgres is up and accepting connections, so the fault is in the application's connection handling, not the database or the gateway. |
| baseline | 3 | correct | pool✔ leak✔ loc✔ | 8,115 | 9.1s | 3/3 | A connection leak in order-service: the '/orders/leaky' code path acquires pg pool clients and never releases them ('will not release'). After a burst of requests the pool is saturated (total=10 idle=0 waiting=5), so subsequent /orders requests wait on the pool until the gateway's 3s upstream timeout fires. Postgres itself is healthy (running, no restarts or errors since startup), and the gateway is only reporting the timeout, so the fault is the unreleased pool clients in order-service. |
| agent | 4 | correct | pool✔ leak✔ loc✔ | 18,715 | 13.6s | 4/4 | A connection leak in order-service: the "orders/leaky" code path acquires pg pool clients and never releases them. The pool (max 10) hit total=10 idle=0 with 5 requests waiting, so all later /orders requests block until the gateway's 3s upstream timeout fires. Postgres itself is healthy and accepting connections, and the containers are not resource constrained. |
| baseline | 4 | correct | pool✔ leak✔ loc✔ | 8,161 | 9.2s | 4/4 | A connection leak in order-service: the 'leaky' orders code path acquires pg pool clients and never releases them ('will not release'). Once the 10-connection pool is fully held by leaked clients, every subsequent /orders request waits for a client that never frees up, and the gateway's 3s upstream timeout fires, producing 504s. Postgres itself is healthy (running, accepting connections, no restarts); the fault is client-side pool exhaustion in the order-service. |
| agent | 5 | correct | pool✔ leak✔ loc✔ | 18,137 | 14.1s | 5/5 | A connection leak in order-service: the "orders/leaky" code path acquires pg pool clients and never releases them. At 17:01:30 the pool reached its maximum of 10 clients with 0 idle and 5 requests waiting. After that, GET /orders requests block waiting for a free client until the gateway gives up with 504 after about 3s. Before the leak (16:27:01) the same endpoint returned 200 in 55ms, with clients acquired and released normally. Postgres was running and accepting connections, and its earlier shutdown on 09-30 was a separate past event. |
| baseline | 5 | correct | pool✔ leak✔ loc✔ | 8,192 | 9.3s | 4/4 | A connection leak in order-service: the 'orders/leaky' code path acquires pg pool clients and never releases them. The pool hit its max of 10 clients with 0 idle and 5 waiters, so subsequent /orders requests block until the gateway's ~3s upstream timeout fires. Postgres itself is healthy (running, accepting connections, no restarts or OOM), and the gateway is only a victim of the upstream stall. The earlier shutdown/FATAL 57P01 entries are from an unrelated, earlier planned Postgres shutdown on 2026-09-30. |
