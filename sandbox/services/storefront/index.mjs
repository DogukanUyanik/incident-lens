import { randomUUID } from "node:crypto";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://gateway:8080";
const ORDERS_PER_SECOND = Number(process.env.ORDERS_PER_SECOND ?? 10);
const LINES_PER_ORDER = Number(process.env.LINES_PER_ORDER ?? 2000);
const MAX_IN_FLIGHT = 20;
const REPORT_EVERY_MS = 10_000;

let inFlight = 0;
const newWindow = () => ({ submitted: 0, deferred: 0, ok: 0, failed: new Map() });
let window = newWindow();

function bulkOrder() {
  const items = [];
  for (let i = 0; i < LINES_PER_ORDER; i++) {
    items.push({
      sku: `SKU-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
      quantity: 1 + Math.floor(Math.random() * 12),
      price: Math.round(Math.random() * 20_000) / 100,
    });
  }
  return { customerId: `cust-${Math.floor(Math.random() * 5000)}`, currency: "EUR", items };
}

function recordFailure(reason) {
  window.failed.set(reason, (window.failed.get(reason) ?? 0) + 1);
}

async function submit() {
  if (inFlight >= MAX_IN_FLIGHT) {
    window.deferred++;
    return;
  }
  inFlight++;
  window.submitted++;
  try {
    const res = await fetch(`${GATEWAY_URL}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(bulkOrder()),
      signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer();
    if (res.ok) window.ok++;
    else recordFailure(String(res.status));
  } catch (err) {
    recordFailure(err instanceof Error ? err.name : "error");
  } finally {
    inFlight--;
  }
}

setInterval(submit, 1000 / ORDERS_PER_SECOND);

setInterval(() => {
  const failedTotal = [...window.failed.values()].reduce((a, b) => a + b, 0);
  const detail = [...window.failed].map(([reason, n]) => `${reason}×${n}`).join(", ");
  console.log(
    `[storefront] last ${REPORT_EVERY_MS / 1000}s: submitted=${window.submitted} deferred=${window.deferred} ` +
      `responses ok=${window.ok} failed=${failedTotal}${detail ? ` (${detail})` : ""}`
  );
  window = newWindow();
}, REPORT_EVERY_MS);

console.log(`storefront started, sending orders to ${GATEWAY_URL}`);
