#!/usr/bin/env bash
# Scenario 3: commit a change to the order-service deploy history, build order-service from that history
# (docker-compose.corrupt-deploy.yml) and deploy it, then send orders through the gateway and expect immediate 500s.
# Reset with ./sandbox/chaos/reset.sh.
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/../deploy-history/lib.sh"

GATEWAY_URL="http://localhost:8080"
SUBJECT="Refactor order payload parsing"
BODY="Parse line prices into a Money value (amount + currency) in preparation for multi-currency carts."
ORDER='{"customerId":"cust-1042","currency":"EUR","items":[{"sku":"SKU-000123","quantity":2,"price":19.99},{"sku":"SKU-004711","quantity":1,"price":5.5}]}'
cd "${SANDBOX_DIR}" || exit 1

echo "==> Checking the sandbox is in its clean state..."
status="$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "${GATEWAY_URL}/orders")"
head_subject="$(history_git log -1 --format=%s 2>/dev/null)"
if [ "${status}" != "200" ] || [ -z "${head_subject}" ] || [ "${head_subject}" = "${SUBJECT}" ]; then
  echo "Sandbox is not in its clean state (GET /orders -> ${status}, history HEAD: ${head_subject:-none})." >&2
  echo "Run ./sandbox/chaos/reset.sh first." >&2
  exit 1
fi

echo "==> Committing \"${SUBJECT}\" to the order-service deploy history..."
history_apply "${HISTORY_PATCHES}/break/refactor-payload-parsing.patch"
history_commit "Priya Raman" "priya.raman@shop.example" "-3 minutes -41 seconds" "${SUBJECT}" "${BODY}"
history_git log -1 --format='  %h %ad %an: %s' --date=iso

echo "==> Building and deploying order-service from the deploy history..."
docker compose -f docker-compose.yml -f docker-compose.corrupt-deploy.yml up -d --build --no-deps order-service || exit 1

echo "==> Waiting for order-service to come up (GET /health through the gateway)..."
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "${GATEWAY_URL}/health")" = "200" ] && break
  sleep 1
done

echo "==> Sending 10 orders to POST ${GATEWAY_URL}/orders..."
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "  order ${i}: %{http_code} (%{time_total}s)\n" --max-time 5 \
    -X POST -H "content-type: application/json" -H "idempotency-key: chk-$(date +%s%N)-${i}" \
    -d "${ORDER}" "${GATEWAY_URL}/orders"
done

result="$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 5 \
  -X POST -H "content-type: application/json" -d "${ORDER}" "${GATEWAY_URL}/orders")"
code="${result% *}"; secs="${result#* }"
if [ "${code}" = "500" ] && awk "BEGIN { exit !(${secs} < 1) }"; then
  echo "==> PASS: POST /orders returned 500 after ${secs}s (an immediate error, not a timeout)."
else
  echo "==> FAIL: expected an immediate 500, got ${code} after ${secs}s." >&2
  exit 1
fi
