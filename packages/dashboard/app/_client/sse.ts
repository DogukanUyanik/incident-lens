/**
 * Reads Server-Sent Events from a fetch() response. fetch is used instead of EventSource because trigger, reset and
 * live are POSTs, and EventSource can only GET.
 */

export interface Frame {
  event: string;
  data: unknown;
}

export function parseFrame(raw: string): Frame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
}

export async function* readFrames(res: Response): AsyncGenerator<Frame> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let i: number;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      const frame = parseFrame(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
      if (frame) yield frame;
    }
  }
  const last = parseFrame(buffer);
  if (last) yield last;
}

/** The error message from a refused request (the API answers with {"error": "..."}). */
export async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; retry_after_s?: number };
    const wait = body.retry_after_s ? ` (try again in ${body.retry_after_s}s)` : "";
    return `${body.error ?? `HTTP ${res.status}`}${wait}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
