#!/usr/bin/env bash
# Test fixture for the upstream-scenario plumbing: run a pinned third-party image (docker-compose.upstream-fixture.yml)
# next to the sandbox and wait until it answers. No failure is injected. Reset with ./sandbox/chaos/reset.sh.
set -uo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_URL="http://localhost:8080"
FIXTURE_URL="http://localhost:8090"
TIMEOUT_S=60
cd "${SANDBOX_DIR}" || exit 1

echo "==> Checking the sandbox is in its clean state..."
status="$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "${GATEWAY_URL}/orders")"
if [ "${status}" != "200" ]; then
  echo "Sandbox is not in its clean state (GET /orders -> ${status})." >&2
  echo "Run ./sandbox/chaos/reset.sh first." >&2
  exit 1
fi

echo "==> Applying the upstream-fixture compose override..."
docker compose -f docker-compose.yml -f docker-compose.upstream-fixture.yml up -d upstream-fixture || exit 1

echo "==> Waiting for GET ${FIXTURE_URL}/ to return 200 (up to ${TIMEOUT_S}s)..."
for _ in $(seq 1 "${TIMEOUT_S}"); do
  status="$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "${FIXTURE_URL}/")"
  if [ "${status}" = "200" ]; then
    echo "==> PASS: upstream-fixture is up (GET / -> 200)."
    exit 0
  fi
  sleep 1
done
echo "==> FAIL: upstream-fixture did not return 200 within ${TIMEOUT_S}s (last status: ${status})." >&2
exit 1
