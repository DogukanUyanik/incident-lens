#!/usr/bin/env bash
set -uo pipefail

ORDER_SERVICE_URL="http://localhost:4000"
GATEWAY_URL="http://localhost:8080"

echo "==> Waiting for order-service to be ready..."
ready=0
for _ in $(seq 1 10); do
  if curl -s -o /dev/null --max-time 2 "${ORDER_SERVICE_URL}/health"; then
    ready=1
    break
  fi
  sleep 1
done

if [ "${ready}" -ne 1 ]; then
  echo "order-service did not become ready in time" >&2
  exit 1
fi

echo "==> Firing 15 concurrent requests at ${ORDER_SERVICE_URL}/orders/leaky (pool max is 10)..."
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "  request ${i}: %{http_code}\n" --max-time 5 "${ORDER_SERVICE_URL}/orders/leaky" &
done
wait

echo "==> Pool should now be exhausted. Checking /health..."
curl -s --max-time 2 "${ORDER_SERVICE_URL}/health"
echo

echo "==> Requesting ${GATEWAY_URL}/orders through the gateway (expecting a 504)..."
body_file="$(mktemp)"
status_code="$(curl -s -o "${body_file}" -w "%{http_code}" --max-time 8 "${GATEWAY_URL}/orders")"

echo "==> Gateway response status: ${status_code}"
echo "==> Gateway response body:"
cat "${body_file}"
echo
rm -f "${body_file}"

if [ "${status_code}" = "504" ]; then
  echo "==> PASS: gateway returned 504 Gateway Timeout as expected."
else
  echo "==> FAIL: expected 504, got ${status_code}."
  exit 1
fi
