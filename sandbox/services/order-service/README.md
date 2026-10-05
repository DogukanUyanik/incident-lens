# order-service

Order API backed by Postgres.

## Endpoints

- `GET /health`: pool statistics
- `GET /orders`: database round trip
- `POST /orders`: create an order. Body: `{ "customerId": "...", "currency": "EUR", "items": [{ "sku": "...", "quantity": 1, "price": 9.99 }] }`.
  Send an `Idempotency-Key` header to make retries safe.

## Local development

```bash
npm install
PGHOST=localhost npm start
```

Configuration comes from `PORT` and the standard `PG*` environment variables.
