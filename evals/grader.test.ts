import { test } from "node:test";
import assert from "node:assert/strict";
import { citationValidity, describeGrade, gradeRootCause } from "./grader.js";
import { loadScenarios } from "./scenarios.js";
import type { EvidenceCheck } from "../packages/agent/src/verifier.js";

type Case = { name: string; root_cause: string; summary?: string; expected: boolean };

const scenarios = new Map(loadScenarios().map((s) => [s.id, s]));
const grading = (id: string) => {
  const s = scenarios.get(id);
  assert.ok(s, `scenario ${id} missing from scenarios.json`);
  return s.grading;
};

function classify(id: string, summary: string, cases: Case[]) {
  const rows = cases.map((c) => {
    const grade = gradeRootCause({ root_cause: c.root_cause, summary: c.summary ?? summary }, grading(id));
    return { ...c, grade, match: grade.correct === c.expected };
  });

  console.log(`\n  [${id}]\n  verdict    expected   match  signals                              case`);
  for (const r of rows) {
    console.log(
      `  ${(r.grade.correct ? "correct" : "wrong").padEnd(10)} ${(r.expected ? "correct" : "wrong").padEnd(10)} ` +
        `${(r.match ? "✔" : "✘").padEnd(6)} ${describeGrade(r.grade).padEnd(36)} ${r.name}`
    );
  }
  for (const r of rows) assert.equal(r.grade.correct, r.expected, `${id}: ${r.name}`);
}

// ── scenario 1: the Phase 4 cases, unchanged, now graded from scenarios.json ─────────────────────────────────

const SUMMARY = "The gateway returns 504 on GET /orders.";

const cases: Case[] = [
  {
    name: "canonical correct",
    root_cause:
      "Connection pool leak in order-service: /orders/leaky acquires a pg client and never releases it, " +
      "so the 10-connection pool is exhausted and /orders waits forever.",
    expected: true,
  },
  {
    name: "correct, phrased differently",
    root_cause:
      "/orders/leaky checks out a pg client and never gives it back; order-service's 10-slot pool fills, " +
      "so every later query waits for a connection that is never returned.",
    expected: true,
  },
  {
    name: "symptom only: gateway 504",
    root_cause: "The gateway timed out after 3s waiting for the upstream and returned 504 Gateway Timeout.",
    expected: false,
  },
  {
    name: "symptom only: order-service slow",
    root_cause: "order-service is slow to respond to /orders requests, exceeding the gateway timeout.",
    expected: false,
  },
  {
    name: "exhaustion without the leak mechanism",
    root_cause: "order-service's database connection pool is exhausted under high load (total=10 idle=0).",
    expected: false,
  },
  {
    name: "wrong cause: postgres down",
    root_cause: "Postgres is down, so order-service cannot open database connections and requests hang.",
    expected: false,
  },
  {
    name: "negated leak",
    root_cause:
      "This is not a connection leak in order-service; Postgres is overloaded and slow to accept queries " +
      "from the pool.",
    expected: false,
  },
  {
    name: "endpoint name only ('leaky' is not 'leak')",
    root_cause: "Requests to the order-service /orders/leaky endpoint exhaust the connection pool.",
    expected: false,
  },
  {
    name: "KNOWN WEAKNESS: hedged multi-cause answer passes",
    root_cause: "Either a connection pool leak in order-service or Postgres being down.",
    expected: true,
  },
  {
    name: "real Phase 3 root_cause",
    root_cause:
      "A connection leak in order-service. A code path (logged as `orders/leaky`) acquires a DB client from the " +
      "pool and never releases it. At 19:16:45 the pool reached its maximum (total=10 idle=0) with waiting " +
      "requests growing. Normal requests, which previously acquired and released a single client in under 1ms, " +
      "now wait indefinitely for a free client. The gateway's 3s upstream timeout then fires and returns 504. " +
      "Postgres is healthy and was not restarted, and neither container is resource-constrained, so the fault " +
      "is application-level pool exhaustion rather than a database outage.",
    expected: true,
  },
  {
    name: "'now'/'another' just before 'never releases'",
    root_cause:
      "order-service's pool is full: the leaky handler now takes another connection and never releases it.",
    expected: true,
  },
];

test("root-cause grader classifies the hand-written examples", () => {
  classify("db-pool-exhaustion", SUMMARY, cases);
});

test("location may come from the summary", () => {
  const grade = gradeRootCause(
    {
      root_cause: "A DB client is acquired from the pool and never released.",
      summary: "order-service requests hang and the gateway returns 504.",
    },
    grading("db-pool-exhaustion")
  );
  assert.equal(grade.correct, true);
});

// ── scenario 2: memory leak with OOM kills ───────────────────────────────────────────────────────────────────

test("memory-leak-oom grader classifies the hand-written examples", () => {
  classify("memory-leak-oom", "The gateway intermittently returns 502 on /orders.", [
    {
      name: "canonical correct",
      root_cause:
        "order-service has a memory leak: memory grows steadily under load until it hits the 160 MiB container " +
        "limit and is OOM-killed, then the restart policy restarts it and the cycle repeats.",
      expected: true,
    },
    {
      name: "correct, phrased differently",
      root_cause:
        "The Idempotency-Key replay cache in order-service keeps every request body with no eviction, so RSS " +
        "climbs until the kernel kills the process for exceeding its memory limit (exit 137).",
      expected: true,
    },
    {
      name: "symptom only: keeps restarting",
      root_cause: "The order-service container keeps restarting, so the gateway gets connection refused and returns 502.",
      expected: false,
    },
    {
      name: "symptom only: crash loop",
      root_cause: "order-service is in a crash loop; requests during restarts fail at the gateway with 502.",
      expected: false,
    },
    {
      name: "wrong cause: limit too low (no growth)",
      root_cause: "order-service is OOM-killed because its 160 MiB memory limit is too low for normal traffic.",
      expected: false,
    },
    {
      name: "wrong cause: postgres",
      root_cause: "Postgres drops connections, which crashes order-service and makes the gateway return 502.",
      expected: false,
    },
    {
      name: "negated leak",
      root_cause:
        "order-service restarts at its memory limit, but this is not a memory leak; the storefront burst is simply " +
        "larger than the container can hold.",
      expected: false,
    },
    {
      name: "KNOWN WEAKNESS: growth phrasing outside the list",
      root_cause: "order-service memory piles up per request until it gets OOM-killed.",
      expected: false,
    },
  ]);
});

// ── scenario 3: corrupt deploy ───────────────────────────────────────────────────────────────────────────────

test("corrupt-deploy grader classifies the hand-written examples", () => {
  classify("corrupt-deploy", "POST /orders fails with 500 at the gateway.", [
    {
      name: "canonical correct",
      root_cause:
        "The latest order-service deploy (commit \"Refactor order payload parsing\") changed src/payload.ts to read " +
        "price.currency, but clients send a numeric price, so every POST /orders throws a TypeError and returns 500.",
      expected: true,
    },
    {
      name: "correct, phrased differently",
      root_cause:
        "A regression introduced a few minutes ago in order-service's line-item parsing: normalizeMoney assumes " +
        "price is an object and crashes on numbers.",
      expected: true,
    },
    {
      name: "symptom only: gateway 500",
      root_cause: "The gateway returns 500 Internal Server Error for POST /orders.",
      expected: false,
    },
    {
      name: "symptom only: exception, no change named",
      root_cause: "order-service throws TypeError: Cannot read properties of undefined on POST /orders.",
      expected: false,
    },
    {
      name: "wrong cause: database down",
      root_cause: "Postgres is unavailable, so order-service cannot insert orders and responds with 500.",
      expected: false,
    },
    {
      name: "negated change",
      root_cause:
        "order-service rejects the order payload; this is not a deploy problem but clients sending bad data.",
      expected: false,
    },
    {
      name: "KNOWN WEAKNESS: wrong component passes",
      root_cause: "A recent gateway deploy broke request body forwarding.",
      summary: "order-service sees broken requests and returns 500.",
      expected: true,
    },
  ]);
});

function check(ok: boolean): EvidenceCheck {
  return { source: "s", quote: "q", ok, matchedIn: [], sourceMismatch: false };
}

test("citation validity is the share of verified quotes", () => {
  assert.deepEqual(citationValidity([check(true), check(true), check(false), check(true)]), {
    ok: 3,
    total: 4,
    share: 0.75,
  });
  assert.equal(citationValidity([check(true)]).share, 1);
  assert.equal(citationValidity([]).share, 0);
});
