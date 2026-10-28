import { checkPrecondition, loadScenarios, runScript } from "./scenarios.js";

/**
 * Exercises a scenario's setup without the model: reset → trigger → precondition → reset. No API calls, no grading,
 * nothing written to results/. Fixtures are allowed, so this is how the upstream plumbing is checked end to end.
 */

const scenarios = loadScenarios();
const i = process.argv.indexOf("--scenario");
const id = i >= 0 ? process.argv[i + 1] : undefined;
const s = scenarios.find((x) => x.id === id);
if (!s) {
  console.error(`usage: npm run check -- --scenario <id>\nscenarios: ${scenarios.map((x) => x.id).join(", ")}`);
  process.exit(2);
}

let ok = runScript(s.reset) && runScript(s.trigger);
if (ok) {
  const failures = await checkPrecondition(s);
  for (const f of failures) console.error(`  precondition failed: ${f}`);
  if (failures.length === 0) console.log(`\nprecondition: ok (${s.precondition.description})`);
  ok = failures.length === 0;
} else {
  console.error(`\nreset or trigger script failed for ${s.id}`);
}
if (!runScript(s.reset)) ok = false;
console.log(`\n${s.id}: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
