export const MAX_CHARS = 4000;

/**
 * Keep the first lines that fit within MAX_CHARS, cutting on a line boundary. For listings and diffs, where the
 * beginning (newest commits, commit metadata, file list) matters most. Logs use the tail instead (see logs.ts).
 */
export function truncateHead(text: string, hint: string): string {
  if (text.length <= MAX_CHARS) return text;

  const lines = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const added = line.length + (kept.length > 0 ? 1 : 0);
    if (size + added > MAX_CHARS) break;
    kept.push(line);
    size += added;
  }
  const body = kept.join("\n");
  return (
    `[TRUNCATED: showing first ${kept.length} of ${lines.length} lines / ${body.length} of ${text.length} chars — ${hint}]\n` +
    body
  );
}
