#!/usr/bin/env bash
# Scenario 2: start the storefront client and run order-service with a memory limit and a restart policy
# (docker-compose.memory-leak.yml), then wait until order-service has been restarted at least twice.
# Reset with ./sandbox/chaos/reset.sh.
set -uo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_URL="http://localhost:8080"
CONTAINER="sandbox-order-service-1"
MIN_RESTARTS=2
TIMEOUT_S=360
cd "${SANDBOX_DIR}" || exit 1

echo "==> Checking the sandbox is in its clean state..."
status="$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "${GATEWAY_URL}/orders")"
memory="$(docker inspect "${CONTAINER}" --format '{{.HostConfig.Memory}}' 2>/dev/null)"
if [ "${status}" != "200" ] || [ "${memory}" != "0" ]; then
  echo "Sandbox is not in its clean state (GET /orders -> ${status}, memory limit=${memory:-n/a})." >&2
  echo "Run ./sandbox/chaos/reset.sh first." >&2
  exit 1
fi

echo "==> Starting storefront and applying the memory-leak compose override..."
docker compose -f docker-compose.yml -f docker-compose.memory-leak.yml up -d --build || exit 1

echo "==> Waiting for ${CONTAINER} to restart at least ${MIN_RESTARTS} times (up to ${TIMEOUT_S}s)..."
start="$(date +%s)"
while :; do
  restarts="$(docker inspect "${CONTAINER}" --format '{{.RestartCount}}')"
  usage="$(docker stats --no-stream --format '{{.MemUsage}}' "${CONTAINER}" 2>/dev/null)"
  elapsed=$(( $(date +%s) - start ))
  echo "  ${elapsed}s: restarts=${restarts} memory=${usage}"
  if [ "${restarts}" -ge "${MIN_RESTARTS}" ]; then
    echo "==> PASS: ${CONTAINER} restarted ${restarts} times; the scenario keeps cycling while storefront runs."
    exit 0
  fi
  if [ "${elapsed}" -ge "${TIMEOUT_S}" ]; then
    echo "==> FAIL: only ${restarts} restarts after ${elapsed}s." >&2
    exit 1
  fi
  sleep 15
done
