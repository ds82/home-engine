#!/usr/bin/env node
// `home-engine-typegen [--out <file>]`: connects to Home Assistant (HA_URL and HA_TOKEN, or
// HA_TOKEN_FILE, or SUPERVISOR_TOKEN inside an add-on) and writes the typings to the file or
// to stdout. `--url` and `--token` override the environment.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fetchTypingsInput } from "./fetch.js";
import { generateTypings } from "./generate.js";

const USAGE = `Usage: home-engine-typegen [--url <url>] [--token <token>] [--out <file>]

Generates a TypeScript declaration file with your Home Assistant's entity IDs, domains and
services, so @home-engine/sdk narrows them in your editor. Without --out it prints to stdout.

Environment: HA_URL, HA_TOKEN (or HA_TOKEN_FILE), SUPERVISOR_TOKEN in add-on mode.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      token: { type: "string" },
      out: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const env = process.env;
  const supervisor = env.SUPERVISOR_TOKEN && !env.HA_URL && !values.url;
  const url = values.url ?? env.HA_URL ?? (supervisor ? "http://supervisor/core" : undefined);
  const token =
    values.token ??
    env.HA_TOKEN ??
    (env.HA_TOKEN_FILE ? readFileSync(env.HA_TOKEN_FILE, "utf8").trim() : undefined) ??
    env.SUPERVISOR_TOKEN;
  if (!url || !token) {
    process.stderr.write(`Set HA_URL and HA_TOKEN (or pass --url and --token).\n\n${USAGE}\n`);
    return 2;
  }
  const input = await fetchTypingsInput({ url, token });
  const typings = generateTypings(input);
  if (values.out) {
    writeFileSync(values.out, typings);
    const services = Object.values(input.services).reduce((n, s) => n + Object.keys(s).length, 0);
    process.stderr.write(
      `Wrote ${values.out}: ${input.states.length} entities, ${services} services\n`,
    );
  } else {
    process.stdout.write(typings);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`typegen failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
