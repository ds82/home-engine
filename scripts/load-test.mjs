#!/usr/bin/env node
// Load test (task 18.2): the built engine against the mock Home Assistant with 5,000 entities,
// 100 state changes per second and 50 rules in 10 files. Measures event-processing latency:
// from the mock sending `state_changed` (stamped into the new state) to the rule body running.
// Fails when p99 >= 50 ms. Run after `npm run build`:
//   node scripts/load-test.mjs [--seconds 60] [--rate 100] [--entities 5000]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { HomeAssistantAdapter, startEngine } from "../packages/engine/dist/index.js";
import { MockHomeAssistant } from "../packages/engine/dist/testing.js";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "60" },
    rate: { type: "string", default: "100" },
    entities: { type: "string", default: "5000" },
  },
});
const SECONDS = Number(values.seconds);
const RATE = Number(values.rate);
const ENTITIES = Number(values.entities);
const TOKEN = "load-test-token";
const BUDGET_P99_MS = 50;

// ---------------------------------------------------------------- fixture
const root = mkdtempSync(join(tmpdir(), "home-engine-load-"));
const rulesDir = join(root, "rules");
const dataDir = join(root, "data");
mkdirSync(rulesDir);
mkdirSync(dataDir);

// 50 rules in 10 files: exact entity IDs, globs, `to` filters, attribute triggers, holds and
// a setup rule with listeners. Each body records its latency in a global array.
const record = `
const latencies = (globalThis.__loadLatencies ??= []);
const seen = (event) => {
  const sentAt = event.to?.attributes?.sentAt;
  if (typeof sentAt === "number") latencies.push(performance.timeOrigin + performance.now() - sentAt);
};`;
for (let f = 0; f < 10; f++) {
  const base = f * 40;
  const rules = [
    `rule("exact ${f}a", onChange(["sensor.load_${base}", "sensor.load_${base + 1}"]), seen);`,
    `rule("exact ${f}b", onChange("sensor.load_${base + 2}", { to: (s) => Number(s) >= 0 }), seen);`,
    `rule("glob ${f}", onChange("sensor.load_${base + 3}*"), seen);`,
    `rule("attribute ${f}", onChange("sensor.load_${base + 4}", { attribute: "sentAt" }), () => {});`,
    `rule("hold ${f}", onChange("binary_sensor.load_${f}", { to: "on", for: "1s" }), () => {});`,
  ];
  writeFileSync(
    join(rulesDir, `load-${f}.ts`),
    `import { onChange, rule } from "@home-engine/sdk";\n${record}\n${rules.join("\n")}\n`,
  );
}

// ------------------------------------------------------------- Home Assistant
const ha = new MockHomeAssistant({ tokens: [TOKEN] });
for (let i = 0; i < ENTITIES - 10; i++) {
  ha.setState(`sensor.load_${i}`, "0", { unit_of_measurement: "W", sentAt: 0 }, { silent: true });
}
for (let i = 0; i < 10; i++) ha.setState(`binary_sensor.load_${i}`, "off", {}, { silent: true });
await ha.start();

// The engine logs to nowhere: the test measures processing, not log output.
const devNull = new Writable({ write: (_c, _e, cb) => cb() });
const engine = await startEngine({
  env: {
    HA_URL: ha.url,
    HA_TOKEN: TOKEN,
    RULES_DIR: rulesDir,
    DATA_DIR: dataDir,
    LOG_LEVEL: "warn",
    LOG_FORMAT: "json",
    HOT_RELOAD: "false",
    NPM_INSTALL: "false",
    HTTP_PORT: "0",
  },
  adapter: new HomeAssistantAdapter(),
  logDestination: devNull,
});
const rules = engine.registry.listRules();
if (rules.length !== 50 || rules.some((r) => r.status !== "running")) {
  throw new Error(`expected 50 running rules, got ${rules.length}`);
}

// ------------------------------------------------------------------- load
// Half the changes hit entities watched by rules, half hit the other ~4,600 sensors (which
// the engine still receives, caches and matches against all triggers).
const watched = [];
for (let f = 0; f < 10; f++) for (let k = 0; k < 4; k++) watched.push(`sensor.load_${f * 40 + k}`);
let n = 0;
const send = () => {
  n++;
  const id =
    n % 2 === 0
      ? watched[n % watched.length]
      : `sensor.load_${400 + ((n * 7919) % (ENTITIES - 410))}`;
  ha.setState(id, String(n % 1000), {
    unit_of_measurement: "W",
    sentAt: performance.timeOrigin + performance.now(),
  });
  if (n % 50 === 0) {
    const b = `binary_sensor.load_${(n / 50) % 10}`;
    ha.setState(b, ha.getState(b)?.state === "on" ? "off" : "on");
  }
};

const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
// The rules captured this array when they loaded; nothing has fired yet.
globalThis.__loadLatencies ??= [];
const started = performance.now();
const interval = 1000 / RATE;
let due = started;
await new Promise((resolve) => {
  const tick = () => {
    const now = performance.now();
    while (due <= now) {
      send();
      due += interval;
    }
    if (now - started >= SECONDS * 1000) return resolve();
    setTimeout(tick, Math.max(0, due - performance.now()));
  };
  tick();
});
const elapsed = (performance.now() - started) / 1000;
// Let the last changes reach the rules.
await new Promise((r) => setTimeout(r, 1000));
lag.disable();

// ---------------------------------------------------------------- results
const samples = [...globalThis.__loadLatencies].sort((a, b) => a - b);
const q = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];
const round = (x) => Math.round(x * 100) / 100;
const result = {
  entities: ENTITIES,
  rules: rules.length,
  seconds: round(elapsed),
  changesSent: n,
  changesPerSecond: round(n / elapsed),
  ruleFirings: samples.length,
  latencyMs: {
    p50: round(q(50)),
    p95: round(q(95)),
    p99: round(q(99)),
    max: round(samples.at(-1)),
  },
  eventLoopDelayMs: { p99: round(lag.percentile(99) / 1e6), max: round(lag.max / 1e6) },
  rssMB: Math.round(process.memoryUsage().rss / 1048576),
  node: process.version,
  cpu: `${cpus().length} × ${cpus()[0]?.model ?? "unknown"}`,
  memoryGB: Math.round(totalmem() / 1073741824),
};
console.log(JSON.stringify(result, null, 2));

await engine.stop();
await ha.stop();
rmSync(root, { recursive: true, force: true });

if (samples.length < n / 4) {
  console.error(`FAIL: only ${samples.length} rule firings for ${n} changes`);
  process.exit(1);
}
if (result.latencyMs.p99 >= BUDGET_P99_MS) {
  console.error(`FAIL: p99 latency ${result.latencyMs.p99} ms >= ${BUDGET_P99_MS} ms`);
  process.exit(1);
}
console.log(`PASS: p99 latency ${result.latencyMs.p99} ms < ${BUDGET_P99_MS} ms`);
process.exit(0);
