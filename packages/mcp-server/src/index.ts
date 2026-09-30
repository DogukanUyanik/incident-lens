import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLogsTool } from "./tools/logs.js";
import { registerStatsTool } from "./tools/stats.js";

// stdout is the MCP protocol channel over stdio: never console.log here, use console.error.

const server = new McpServer({ name: "incidentlens-telemetry", version: "1.0.0" });

registerLogsTool(server);
registerStatsTool(server);

await server.connect(new StdioServerTransport());
console.error("incidentlens-telemetry MCP server running on stdio");
