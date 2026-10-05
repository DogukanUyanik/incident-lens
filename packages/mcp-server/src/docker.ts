import Docker from "dockerode";

// Read-only by design: this module only ever calls listContainers, inspect, logs and stats.
// Do not add start/stop/restart/exec/remove calls here.

const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT ?? "sandbox";
const SERVICE_LABEL = "com.docker.compose.service";
const PROJECT_LABEL = "com.docker.compose.project";

const docker = new Docker();

export class ToolError extends Error {}

/**
 * Resolve a compose service name ("order-service") or exact container name
 * ("sandbox-order-service-1") to a container in the sandbox compose project.
 */
export async function listProjectContainers(): Promise<Docker.ContainerInfo[]> {
  try {
    return await docker.listContainers({
      all: true,
      filters: { label: [`${PROJECT_LABEL}=${COMPOSE_PROJECT}`] },
    });
  } catch (err) {
    throw new ToolError(`Could not reach the Docker daemon: ${String(err)}`);
  }
}

export function composeProject(): string {
  return COMPOSE_PROJECT;
}

export function serviceOf(info: Docker.ContainerInfo): string {
  return info.Labels[SERVICE_LABEL] ?? info.Names[0]?.replace(/^\//, "") ?? info.Id.slice(0, 12);
}

export async function inspectById(id: string) {
  return docker.getContainer(id).inspect();
}

export async function resolveContainer(name: string): Promise<Docker.Container> {
  const containers = await listProjectContainers();

  const match =
    containers.find((c) => c.Labels[SERVICE_LABEL] === name) ??
    containers.find((c) => c.Names.some((n) => n.replace(/^\//, "") === name));

  if (!match) {
    const available = containers.map((c) => c.Labels[SERVICE_LABEL]).sort();
    throw new ToolError(
      available.length === 0
        ? `No containers found for compose project "${COMPOSE_PROJECT}". Is the sandbox running (cd sandbox && docker compose up)?`
        : `Container "${name}" not found in compose project "${COMPOSE_PROJECT}". Available: ${available.join(", ")}`
    );
  }
  return docker.getContainer(match.Id);
}

/**
 * Non-TTY container logs come back multiplexed: each frame has an 8-byte header
 * [stream(1), 0, 0, 0, size(4, big-endian)] followed by `size` bytes of payload.
 */
export function demuxLogs(buf: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf[offset];
    const size = buf.readUInt32BE(offset + 4);
    const payload = buf.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
    for (const line of payload.split("\n")) {
      if (line === "") continue;
      lines.push(stream === 2 ? `[stderr] ${line}` : line);
    }
  }
  return lines;
}

export async function getLogLines(container: Docker.Container, tail: number): Promise<string[]> {
  const buf = (await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
    follow: false,
  })) as unknown as Buffer;
  return demuxLogs(buf);
}

export async function inspect(container: Docker.Container) {
  return container.inspect();
}

// Docker's stats payload; only the fields we use.
interface StatsSnapshot {
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
  };
  memory_stats: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
  pids_stats?: { current?: number };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pids: number | null;
  networkRxBytes: number;
  networkTxBytes: number;
}

export async function getStats(container: Docker.Container): Promise<ContainerStats> {
  // stream: false waits for two samples, so precpu_stats is populated.
  const s = (await container.stats({ stream: false })) as unknown as StatsSnapshot;

  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const systemDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
  const onlineCpus = s.cpu_stats.online_cpus ?? s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

  // Same as `docker stats`: exclude page cache (cgroup v2: inactive_file, v1: total_inactive_file).
  const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.total_inactive_file ?? 0;
  const memoryUsageBytes = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
  const memoryLimitBytes = s.memory_stats.limit ?? 0;
  const memoryPercent = memoryLimitBytes > 0 ? (memoryUsageBytes / memoryLimitBytes) * 100 : 0;

  let networkRxBytes = 0;
  let networkTxBytes = 0;
  for (const net of Object.values(s.networks ?? {})) {
    networkRxBytes += net.rx_bytes;
    networkTxBytes += net.tx_bytes;
  }

  return {
    cpuPercent,
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent,
    pids: s.pids_stats?.current ?? null,
    networkRxBytes,
    networkTxBytes,
  };
}
