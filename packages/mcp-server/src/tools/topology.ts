import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { composeProject, inspectById, listProjectContainers, serviceOf, ToolError } from "../docker.js";
import { truncateHead } from "../truncate.js";

const DEPENDS_ON_LABEL = "com.docker.compose.depends_on";

interface ServiceNode {
  service: string;
  container: string;
  status: string;
  health: string | null;
  ports: string[];
  networks: string[];
  depends_on: string[];
  talks_to: Array<{ service: string; via: string }>;
}

/** Compose writes depends_on as "postgres:service_healthy:false,redis:service_started:true". */
function parseDependsOn(label: string | undefined): string[] {
  if (!label) return [];
  return label
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [service, condition] = entry.split(":");
      return condition ? `${service} (${condition})` : service;
    });
}

type PortMap = Record<string, Array<{ HostIp: string; HostPort: string }> | null> | undefined;

function publishedPorts(ports: PortMap): string[] {
  const out = new Set<string>();
  for (const [containerPort, bindings] of Object.entries(ports ?? {})) {
    for (const b of bindings ?? []) out.add(`${b.HostPort}->${containerPort}`);
  }
  return [...out].sort();
}

/**
 * Other services whose name appears as a hostname in an environment variable value (e.g. PGHOST=postgres,
 * ORDER_SERVICE_URL=http://order-service:4000). Only the variable name is reported, never its value.
 */
function talksTo(env: string[] | undefined, self: string, services: string[]): ServiceNode["talks_to"] {
  const found: ServiceNode["talks_to"] = [];
  for (const entry of env ?? []) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    const value = entry.slice(eq + 1).toLowerCase();
    for (const other of services) {
      if (other === self) continue;
      const host = new RegExp(`(^|[^a-z0-9.-])${other.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}($|[^a-z0-9.-])`);
      if (host.test(value)) found.push({ service: other, via: name });
    }
  }
  return found;
}

export function registerTopologyTool(server: McpServer) {
  server.registerTool(
    "get_cluster_topology",
    {
      title: "Get cluster topology",
      description:
        "List the containers in the sandbox compose project with status, health, published ports, networks, the " +
        "services each one depends on (compose depends_on), and the services it is configured to talk to (another " +
        "service's hostname in an environment variable; only the variable name is shown). " +
        "Output is capped at 4000 characters.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const containers = await listProjectContainers();
        const services = containers.map(serviceOf);
        const nodes: ServiceNode[] = [];
        for (const info of containers) {
          const service = serviceOf(info);
          const details = await inspectById(info.Id);
          nodes.push({
            service,
            container: details.Name.replace(/^\//, ""),
            status: details.State.Status,
            health: details.State.Health?.Status ?? null,
            ports: publishedPorts(details.NetworkSettings.Ports as PortMap),
            networks: Object.keys(details.NetworkSettings.Networks ?? {}).sort(),
            depends_on: parseDependsOn(details.Config.Labels?.[DEPENDS_ON_LABEL]),
            talks_to: talksTo(details.Config.Env, service, services),
          });
        }
        nodes.sort((a, b) => a.service.localeCompare(b.service));
        const text = JSON.stringify({ project: composeProject(), services: nodes }, null, 2);
        return { content: [{ type: "text", text: truncateHead(text, "output exceeds the cap") }] };
      } catch (err) {
        const message = err instanceof ToolError ? err.message : `Failed to read topology: ${String(err)}`;
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );
}
