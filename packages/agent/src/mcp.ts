import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type BetaTool = Anthropic.Beta.Messages.BetaTool;

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_DIR = path.resolve(here, "../../mcp-server");

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface TelemetryClient {
  tools: BetaTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

/**
 * Spawn the Phase 2 MCP server over stdio and expose its tools in Claude's tool format.
 * Tool names and schemas come from the server's own tools/list response — nothing is hardcoded here.
 */
export async function connectTelemetry(): Promise<TelemetryClient> {
  const serverDir = process.env.MCP_SERVER_DIR ?? DEFAULT_SERVER_DIR;
  const client = new Client({ name: "incidentlens-agent", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: serverDir,
      stderr: "ignore",
    })
  );

  const { tools: mcpTools } = await client.listTools();
  const tools: BetaTool[] = mcpTools.map((t) => {
    // MCP inputSchema is already a JSON Schema object with type "object", which is what
    // Claude's input_schema expects; only drop the "$schema" dialect marker.
    const { $schema: _dialect, ...schema } = t.inputSchema as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description ?? t.title ?? "",
      input_schema: schema as BetaTool["input_schema"],
    };
  });

  return {
    tools,
    async callTool(name, args) {
      try {
        const result = await client.callTool({ name, arguments: args });
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
        const text = content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n");
        return { text, isError: result.isError === true };
      } catch (err) {
        return { text: `MCP call failed: ${String(err)}`, isError: true };
      }
    },
    close: () => client.close(),
  };
}
