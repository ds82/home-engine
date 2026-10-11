#!/usr/bin/env node
// `home-engine`: starts the engine against Home Assistant with the configuration from the
// environment. Invalid configuration exits with code 1 and one line per problem. SIGTERM or
// SIGINT shut down gracefully: exit code 0, or 1 when shutdown exceeded 10 s (the log names
// the rule that blocked it) or a second signal arrived.

import { HomeAssistantAdapter } from "./adapters/home-assistant/index.js";
import { ConfigError } from "./core/config.js";
import { startEngine, type Engine } from "./core/engine.js";

async function main(): Promise<void> {
  const startup = new AbortController();
  let engine: Engine | undefined;
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) {
      engine?.log.warn({ signal }, `Received ${signal} again; exiting immediately`);
      process.exit(1);
    }
    stopping = true;
    if (!engine) {
      // Still starting (e.g. waiting for Home Assistant): give up connecting.
      startup.abort();
      return;
    }
    engine.log.info({ signal }, `Received ${signal}`);
    void engine.stop().then(
      (result) => process.exit(result.clean ? 0 : 1),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    engine = await startEngine({
      env: process.env,
      adapter: new HomeAssistantAdapter(),
      signal: startup.signal,
    });
  } catch (err) {
    if (startup.signal.aborted) process.exit(0);
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`home-engine failed to start: ${(err as Error).stack ?? String(err)}\n`);
    }
    process.exit(1);
  }
}

void main();
