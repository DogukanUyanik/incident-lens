/**
 * Drains `source` to the end on its own, whether or not anyone is reading. A reader gets every item from the
 * start; if the reader goes away (the browser closed the tab), the source still runs to completion. This keeps a
 * reset script or a paid live run from being cut off half-way, and `done` settles only when it really finished.
 */
export function pump<T>(source: AsyncIterable<T>): { items: AsyncIterable<T>; done: Promise<void> } {
  const buffer: T[] = [];
  let finished = false;
  let failure: unknown;
  let wake: (() => void) | undefined;

  const done = (async () => {
    try {
      for await (const item of source) {
        buffer.push(item);
        wake?.();
      }
    } catch (err) {
      failure = err;
    } finally {
      finished = true;
      wake?.();
    }
  })();

  async function* items(): AsyncGenerator<T> {
    let i = 0;
    while (true) {
      while (i < buffer.length) yield buffer[i++];
      if (finished) {
        if (failure !== undefined) throw failure;
        return;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
  }

  return { items: items(), done: done.then(() => (failure === undefined ? undefined : Promise.reject(failure))) };
}
