import "dotenv/config"; 
import { connectTelemetry } from "./mcp.js";
import { investigate } from "./agent.js";
import { SUBMIT_REPORT } from "./report.js";

const DEFAULT_ALERT = "the gateway is returning 504 Gateway Timeout errors on GET /orders";

const alert = process.argv.slice(2).join(" ").trim() || DEFAULT_ALERT;

const telemetry = await connectTelemetry();
let exitCode = 1;
try {
  if (telemetry.tools.some((t) => t.name === SUBMIT_REPORT)) {
    throw new Error(`MCP server exposes a tool named "${SUBMIT_REPORT}", which clashes with the agent's own tool`);
  }
  console.log(`alert: ${alert}`);
  console.log(`tools from MCP server: ${telemetry.tools.map((t) => t.name).join(", ")}`);

  const result = await investigate(alert, telemetry);

  console.log("\n════════ incident report ════════");
  if (result.ok && result.report && result.checks) {
    console.log(`summary:    ${result.report.summary}`);
    console.log(`root cause: ${result.report.root_cause}`);
    console.log("evidence:");
    for (const c of result.checks) {
      console.log(`  ✔ ${JSON.stringify(c.quote)}`);
      console.log(`      source: ${c.source}`);
      console.log(`      verified in: ${c.matchedIn.join("; ")}`);
      if (c.sourceMismatch) console.log(`      ! quote found, but not in the call named by source`);
    }
    console.log(`\nverified report accepted after ${result.turns} turn(s)`);
    exitCode = 0;
  } else {
    console.log(`FAILED: ${result.failure}`);
    for (const c of result.checks?.filter((c) => !c.ok) ?? []) {
      console.log(`  ✘ ${JSON.stringify(c.quote)} — ${c.reason}`);
    }
  }
} catch (err) {
  console.error(`agent error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await telemetry.close();
}
process.exit(exitCode);
