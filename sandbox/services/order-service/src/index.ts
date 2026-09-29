import express from "express";
import { Pool } from "pg";

const PORT = Number(process.env.PORT ?? 4000);

const pool = new Pool({
  host: process.env.PGHOST ?? "postgres",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "incidentlens",
  password: process.env.PGPASSWORD ?? "incidentlens",
  database: process.env.PGDATABASE ?? "incidentlens",
  max: 10,
});

const app = express();

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

app.listen(PORT, () => {
  console.log(`order-service listening on ${PORT}`);
});
