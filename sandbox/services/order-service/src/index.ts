import express, { type NextFunction, type Request, type Response } from "express";
import { Pool } from "pg";
import { idempotency, type RawBodyRequest } from "./idempotency.js";
import { parseOrder, PayloadError } from "./payload.js";

const PORT = Number(process.env.PORT ?? 4000);

const pool = new Pool({
  host: process.env.PGHOST ?? "postgres",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "incidentlens",
  password: process.env.PGPASSWORD ?? "incidentlens",
  database: process.env.PGDATABASE ?? "incidentlens",
  max: 10,
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    customer_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    line_count INTEGER NOT NULL,
    total NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

const app = express();

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => {
  res.json({
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

app.get("/orders", async (_req, res) => {
  const client = await pool.connect();
  console.log(
    `[orders] acquired client (total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount})`
  );
  try {
    await client.query("SELECT 1");
    res.json({ ok: true });
  } finally {
    client.release();
    console.log(
      `[orders] released client (total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount})`
    );
  }
});

app.get("/orders/leaky", async (_req, res) => {
  const client = await pool.connect();
  console.log(
    `[orders/leaky] acquired client, will not release (total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount})`
  );
  await client.query("SELECT 1");
  res.json({ ok: true, leaked: true });
});

app.post("/orders", idempotency, async (req, res, next) => {
  try {
    const order = parseOrder(req.body);
    const { rows } = await pool.query(
      "INSERT INTO orders (customer_id, currency, line_count, total) VALUES ($1, $2, $3, $4) RETURNING id",
      [order.customerId, order.currency, order.lines.length, order.total]
    );
    res.status(201).json({
      id: rows[0].id,
      customerId: order.customerId,
      currency: order.currency,
      lines: order.lines.length,
      total: order.total,
    });
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof PayloadError) {
    res.status(400).json({ error: "invalid_payload", message: err.message });
    return;
  }
  if (err && typeof err === "object" && "type" in err && err.type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_json" });
    return;
  }
  console.error(`[orders] ${req.method} ${req.path} failed: ${err instanceof Error ? err.stack : String(err)}`);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`order-service listening on ${PORT}`);
});
