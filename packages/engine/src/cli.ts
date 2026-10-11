#!/usr/bin/env node
// `home-engine`: starts the engine against Home Assistant with the configuration from the
// environment. Invalid configuration exits with code 1 and one line per problem.

import { HomeAssistantAdapter } from "./adapters/home-assistant/index.js";
import { ConfigError } from "./core/config.js";
import { startEngine, type Engine } from "./core/engine.js";

async function main(): Promise<void> {
  let engine: Engine;
  try {
    engine = await startEngine({ env: process.env, adapter: new HomeAssistantAdapter() });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`home-engine failed to start: ${(err as Error).stack ?? String(err)}\n`);
    }
    process.exit(1);
  }
  const shutdown = (signal: string): void => {
    engine.log.info({ signal }, `Received ${signal}; shutting down`);
    void engine.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

void main();
