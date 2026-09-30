import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStats, inspect, resolveContainer, ToolError } from "../docker.js";

const MiB = 1024 * 1024;

function formatUptime(startedAt: string): string | null {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started) || started <= 0) return null;
  const seconds = Math.floor((Date.now() - started) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

export function registerStatsTool(server: McpServer) {
  server.registerTool(
    "get_container_stats",
    {
      title: "Get container stats",
      description:
        "Fetch a live resource snapshot for a sandbox container: CPU %, memory usage/limit, pids, network I/O, " +
        "plus state, start time/uptime and restart count. Note: restartCount only counts restart-policy restarts, " +
        "not manual restarts — use startedAt/uptime to detect those.",
      inputSchema: {
        container: z
          .string()
          .describe('Compose service name, e.g. "order-service", "gateway" or "postgres"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ container }) => {
      try {
        const target = await resolveContainer(container);
        const info = await inspect(target);

        const result: Record<string, unknown> = {
          container,
          containerName: info.Name.replace(/^\//, ""),
          status: info.State.Status,
          startedAt: info.State.StartedAt,
          uptime: info.State.Running ? formatUptime(info.State.StartedAt) : null,
          restartCount: info.RestartCount,
          oomKilled: info.State.OOMKilled,
          exitCode: info.State.Running ? null : info.State.ExitCode,
        };

        if (info.State.Running) {
          const stats = await getStats(target);
          Object.assign(result, {
            cpuPercent: Number(stats.cpuPercent.toFixed(2)),
            memoryUsageMiB: Number((stats.memoryUsageBytes / MiB).toFixed(2)),
            memoryLimitMiB: Number((stats.memoryLimitBytes / MiB).toFixed(2)),
            memoryPercent: Number(stats.memoryPercent.toFixed(2)),
            pids: stats.pids,
            networkRxBytes: stats.networkRxBytes,
            networkTxBytes: stats.networkTxBytes,
          });
        } else {
          result.stats = "unavailable (container is not running)";
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof ToolError ? err.message : `Failed to fetch stats: ${String(err)}`;
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );
}
