#!/usr/bin/env bash
# Reset the sandbox to a clean, healthy state after any scenario:
#   - regenerate the clean deploy history (the previous one is moved aside, not deleted)
#   - re-apply the base compose config only (drops scenario overrides; removes scenario-only containers such as storefront)
#   - recreate gateway and order-service (fresh connection pool, restart count 0, cleared logs); postgres is kept
#   - verify GET /orders through the gateway returns 200
set -uo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_URL="http://localhost:8080"
cd "${SANDBOX_DIR}" || exit 1

echo "==> Regenerating clean deploy history..."
./deploy-history/generate.sh || exit 1

echo "==> Applying base compose config (removes scenario-only containers)..."
docker compose -f docker-compose.yml up -d --build --remove-orphans || exit 1

echo "==> Recreating gateway and order-service..."
docker compose -f docker-compose.yml up -d --force-recreate --no-deps gateway order-service || exit 1

echo "==> Waiting for GET ${GATEWAY_URL}/orders to return 200..."
for _ in $(seq 1 60); do
  status="$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "${GATEWAY_URL}/orders")"
  if [ "${status}" = "200" ]; then
    echo "==> PASS: sandbox is healthy (GET /orders -> 200)."
    exit 0
  fi
  sleep 1
done
echo "==> FAIL: GET /orders did not return 200 within 60s (last status: ${status})." >&2
exit 1
