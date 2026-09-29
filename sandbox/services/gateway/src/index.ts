import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://order-service:4000";
const TIMEOUT_MS = 3000;

const ALLOWED_PATHS = new Set(["/health", "/orders", "/orders/leaky"]);

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const path = req.url ?? "";

  if (req.method !== "GET" || !ALLOWED_PATHS.has(path)) {
    console.log(`[gateway] ${req.method} ${path} -> 404 (not allowed)`);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
    return;
  }

  try {
    const upstream = await fetch(`${ORDER_SERVICE_URL}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await upstream.text();
    const duration = Date.now() - start;
    console.log(`[gateway] GET ${path} -> ${upstream.status} (${duration}ms)`);
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(body);
  } catch (err) {
    const duration = Date.now() - start;
    if (err instanceof Error && err.name === "TimeoutError") {
      console.log(`[gateway] GET ${path} -> 504 (timed out after ${duration}ms)`);
      res.writeHead(504, { "content-type": "text/plain" });
      res.end("Gateway Timeout");
      return;
    }
    console.log(`[gateway] GET ${path} -> 502 (${duration}ms): ${String(err)}`);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("Bad Gateway");
  }
});

server.listen(PORT, () => {
  console.log(`gateway listening on ${PORT}, proxying to ${ORDER_SERVICE_URL}`);
});
