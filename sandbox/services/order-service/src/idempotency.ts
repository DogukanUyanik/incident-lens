import type { NextFunction, Request, Response } from "express";

export type RawBodyRequest = Request & { rawBody?: Buffer };

interface StoredResponse {
  status: number;
  body: Buffer;
  request?: Buffer;
  storedAt: number;
}

const responses = new Map<string, StoredResponse>();

/**
 * Replays the stored response when a client retries a request with the same Idempotency-Key.
 */
export function idempotency(req: RawBodyRequest, res: Response, next: NextFunction) {
  const key = req.get("Idempotency-Key");
  if (!key) return next();

  const stored = responses.get(key);
  if (stored) {
    res.status(stored.status).set("Idempotent-Replayed", "true").type("application/json").send(stored.body);
    return;
  }

  const json = res.json.bind(res);
  res.json = (payload: unknown) => {
    if (res.statusCode < 500) {
      responses.set(key, {
        status: res.statusCode,
        body: Buffer.from(JSON.stringify(payload)),
        request: req.rawBody,
        storedAt: Date.now(),
      });
    }
    return json(payload);
  };
  next();
}
