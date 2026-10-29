/** Server-Sent Events: one `event:`/`data:` frame per message, sent as soon as it is produced. */

export interface SseMessage {
  event: string;
  data: unknown;
}

export function sseFrame({ event, data }: SseMessage): string {
  // JSON.stringify never emits a raw newline, so one data line is always enough.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Streams `messages` to the browser. If the browser disconnects, `onCancel` runs (the producer decides what to
 * stop); the response itself just ends.
 */
export function sseResponse(messages: AsyncIterable<SseMessage>, onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const m of messages) {
          if (cancelled) break;
          controller.enqueue(encoder.encode(sseFrame(m)));
        }
      } catch (err) {
        if (!cancelled) {
          controller.enqueue(encoder.encode(sseFrame({ event: "stream_error", data: { message: errorMessage(err) } })));
        }
      }
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
      onCancel?.();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
