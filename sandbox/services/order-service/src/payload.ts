export class PayloadError extends Error {}

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Order {
  customerId: string;
  currency: string;
  lines: OrderLine[];
  total: number;
}

const roundCents = (n: number) => Math.round(n * 100) / 100;

export function normalizeLine(raw: unknown, index: number): OrderLine {
  if (!raw || typeof raw !== "object") throw new PayloadError(`items[${index}] must be an object`);
  const { sku, quantity, price } = raw as Record<string, unknown>;

  if (typeof sku !== "string" || sku.length === 0) {
    throw new PayloadError(`items[${index}].sku is required`);
  }
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
    throw new PayloadError(`items[${index}].quantity must be a positive integer`);
  }
  if (typeof price !== "number" || price < 0) {
    throw new PayloadError(`items[${index}].price must be a non-negative number`);
  }

  const unitPrice = roundCents(price);
  return { sku, quantity, unitPrice, lineTotal: roundCents(unitPrice * quantity) };
}

export function parseOrder(body: unknown): Order {
  if (!body || typeof body !== "object") throw new PayloadError("request body must be a JSON object");
  const { customerId, currency, items } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || customerId.length === 0) {
    throw new PayloadError("customerId is required");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new PayloadError("items must be a non-empty array");
  }

  const lines = items.map(normalizeLine);
  return {
    customerId,
    currency: typeof currency === "string" ? currency.toUpperCase() : "EUR",
    lines,
    total: roundCents(lines.reduce((sum, l) => sum + l.lineTotal, 0)),
  };
}
