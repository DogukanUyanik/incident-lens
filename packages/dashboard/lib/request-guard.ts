/**
 * Checks every API request comes to this server by its loopback name, and that POSTs come from the dashboard page
 * itself. Without the Host check a hostile site could reach the server through DNS rebinding; without the Origin
 * check any page open in the browser could press the trigger button with a cross-site POST.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function loopbackHost(host: string | null): boolean {
  if (!host) return false;
  try {
    return LOOPBACK.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** Returns an error Response when the request must be refused, otherwise null. */
export function guard(request: Request, { post }: { post: boolean }): Response | null {
  const host = request.headers.get("host");
  if (!loopbackHost(host)) return json(403, { error: "requests must use the loopback address" });
  if (!post) return null;

  const origin = request.headers.get("origin");
  let originHost: string | undefined;
  try {
    originHost = origin ? new URL(origin).host : undefined;
  } catch {
    originHost = undefined;
  }
  if (!originHost || originHost !== host) return json(403, { error: "cross-origin request refused" });
  return null;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
