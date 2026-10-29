#!/usr/bin/env bash
# Scenario prometheus-bad-scrape-crash: run pinned Prometheus v3.10.0 and its scrape target metrics-target
# (docker-compose.prometheus-bad-scrape.yml) next to the sandbox, then wait until prometheus has restarted at least
# MIN_RESTARTS times. Reset with ./sandbox/chaos/reset.sh.
set -uo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_URL="http://localhost:8080"
MIN_RESTARTS=3
TIMEOUT_S=120
cd "${SANDBOX_DIR}" || exit 1

echo "==> Checking the sandbox is in its clean state..."
status="$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "${GATEWAY_URL}/orders")"
if [ "${status}" != "200" ]; then
  echo "Sandbox is not in its clean state (GET /orders -> ${status})." >&2
  echo "Run ./sandbox/chaos/reset.sh first." >&2
  exit 1
fi

echo "==> Applying the prometheus-bad-scrape compose override..."
docker compose -f docker-compose.yml -f docker-compose.prometheus-bad-scrape.yml up -d prometheus metrics-target || exit 1
id="$(docker compose -f docker-compose.yml -f docker-compose.prometheus-bad-scrape.yml ps -aq prometheus)"
if [ -z "${id}" ]; then
  echo "==> FAIL: no prometheus container after compose up." >&2
  exit 1
fi

# The restart count alone can't tell this crash from any other (e.g. a startup failure), so the whole log must
# also contain the upstream panic. grep -c reads all input, so docker logs never gets SIGPIPE under pipefail.
EXPECTED_LINE="slice bounds out of range"
echo "==> Waiting for prometheus restart count >= ${MIN_RESTARTS} and the expected log line (up to ${TIMEOUT_S}s)..."
restarts=0
found=0
for i in $(seq 1 "${TIMEOUT_S}"); do
  restarts="$(docker inspect --format '{{.RestartCount}}' "${id}")"
  found="$(docker logs "${id}" 2>&1 | grep -c "${EXPECTED_LINE}")"
  if [ "${restarts}" -ge "${MIN_RESTARTS}" ] && [ "${found}" -gt 0 ]; then
    echo "==> PASS: prometheus restart count is ${restarts} after ${i}s; expected log line found."
    exit 0
  fi
  sleep 1
done
if [ "${restarts}" -ge "${MIN_RESTARTS}" ]; then
  echo "==> FAIL: prometheus restarts (${restarts}) but no scrape panic (\"${EXPECTED_LINE}\") found in its logs" \
    "after ${TIMEOUT_S}s: it is crashing for another reason." >&2
elif [ "${found}" -gt 0 ]; then
  echo "==> FAIL: scrape panic found, but prometheus restart count is only ${restarts} after ${TIMEOUT_S}s," \
    "expected at least ${MIN_RESTARTS}." >&2
else
  echo "==> FAIL: prometheus restart count is ${restarts} and no scrape panic (\"${EXPECTED_LINE}\") found" \
    "after ${TIMEOUT_S}s." >&2
fi
exit 1
