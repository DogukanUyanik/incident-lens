import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getLogLines, resolveContainer, ToolError } from "../docker.js";

const MAX_CHARS = 4000;

/**
 * Keep the most recent lines that fit within MAX_CHARS, cutting on a line boundary.
 */
export function truncateLines(lines: string[]): { text: string; kept: number } {
  const full = lines.join("\n");
  if (full.length <= MAX_CHARS) return { text: full, kept: lines.length };

  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const added = lines[i].length + (kept.length > 0 ? 1 : 0);
    if (size + added > MAX_CHARS) break;
    kept.unshift(lines[i]);
    size += added;
  }
  return { text: kept.join("\n"), kept: kept.length };
}

export function registerLogsTool(server: McpServer) {
  server.registerTool(
    "get_container_logs",
    {
      title: "Get container logs",
      description:
        "Fetch the most recent log lines (stdout and stderr, with Docker timestamps) from a sandbox container. " +
        `Output is capped at ${MAX_CHARS} characters; when capped, the oldest lines are dropped and a TRUNCATED header says so.`,
      inputSchema: {
        container: z
          .string()
          .describe('Compose service name, e.g. "order-service", "gateway" or "postgres"'),
        tail: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Number of most recent lines to fetch (default 100)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ container, tail }) => {
      try {
        const target = await resolveContainer(container);
        const lines = await getLogLines(target, tail);
        const { text, kept } = truncateLines(lines);

        const header = [`container: ${container}`, `lines returned: ${kept} (requested tail=${tail})`];
        if (kept < lines.length) {
          const fullLength = lines.join("\n").length;
          header.unshift(
            `[TRUNCATED: showing last ${kept} of ${lines.length} lines / ${text.length} of ${fullLength} chars — reduce "tail" to see fewer lines]`
          );
        }
        const body = lines.length === 0 ? "(no log output)" : text;
        return { content: [{ type: "text", text: `${header.join("\n")}\n---\n${body}` }] };
      } catch (err) {
        const message = err instanceof ToolError ? err.message : `Failed to fetch logs: ${String(err)}`;
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );
}
