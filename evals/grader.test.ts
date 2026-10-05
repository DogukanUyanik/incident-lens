import { test } from "node:test";
import assert from "node:assert/strict";
import { citationValidity, describeGrade, gradeRootCause } from "./grader.js";
import type { EvidenceCheck } from "../packages/agent/src/verifier.js";

const SUMMARY = "The gateway returns 504 on GET /orders.";

const cases: Array<{ name: string; root_cause: string; summary?: string; expected: boolean }> = [
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
  const rows = cases.map((c) => {
    const grade = gradeRootCause({ root_cause: c.root_cause, summary: c.summary ?? SUMMARY });
    return { ...c, grade, match: grade.correct === c.expected };
  });

  console.log("\n  verdict    expected   match  signals                 case");
  for (const r of rows) {
    console.log(
      `  ${(r.grade.correct ? "correct" : "wrong").padEnd(10)} ${(r.expected ? "correct" : "wrong").padEnd(10)} ` +
        `${(r.match ? "✔" : "✘").padEnd(6)} ${describeGrade(r.grade).padEnd(23)} ${r.name}`
    );
  }

  for (const r of rows) assert.equal(r.grade.correct, r.expected, r.name);
});

test("location may come from the summary", () => {
  const grade = gradeRootCause({
    root_cause: "A DB client is acquired from the pool and never released.",
    summary: "order-service requests hang and the gateway returns 504.",
  });
  assert.equal(grade.correct, true);
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
