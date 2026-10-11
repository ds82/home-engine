// The engine-side implementation of `@home-engine/sdk`. Rule bundles import the SDK through a
// virtual module (see bundler.ts) that reads this object from `globalThis`, so every rule
// shares the engine's single instance. Backend adapters add their functions to it.

import type { Logger } from "./logger.js";
import { currentFileScope, registerSetupRule, registerTriggeredRule } from "./registration.js";
import { listen } from "./rule-runner.js";
import { currentRun, requireRun } from "./run-context.js";
import type { Scheduling } from "./scheduling.js";
import { storageSdk, type Storage } from "./storage.js";
import { cron, daily, every, onStartup, sun } from "./trigger-constructors.js";

export const SDK_RUNTIME_KEY = Symbol.for("home-engine.sdk");

export type SdkRuntime = Record<string, unknown>;

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/**
 * The SDK's `log`: `log.info("turned on", { entity })`. Entries are tagged with the calling
 * rule's ID (or the file's, at the top level of a rule file; else the engine's).
 */
export function ruleLog(engineLog: Logger): Record<(typeof LOG_LEVELS)[number], unknown> {
  const target = (): Logger =>
    currentRun()?.scope.log ??
    (currentFileScope() as { log?: Logger } | undefined)?.log ??
    engineLog;
  return Object.fromEntries(
    LOG_LEVELS.map((level) => [
      level,
      (message: unknown, fields?: Record<string, unknown>) => {
        const text = message instanceof Error ? message.message : String(message);
        const extra = message instanceof Error ? { err: message, ...fields } : fields;
        if (extra) target()[level](extra, text);
        else target()[level](text);
      },
    ]),
  ) as Record<(typeof LOG_LEVELS)[number], unknown>;
}

/** The SDK's `onDispose`: a teardown of the calling rule, run when it is unloaded. */
function onDispose(teardown: () => void | Promise<void>): void {
  if (typeof teardown !== "function") {
    throw new TypeError("onDispose(): the teardown must be a function");
  }
  requireRun("onDispose").scope.addTeardown(teardown);
}

/** The core's SDK functions; adapters extend this object with their own. */
export function coreSdkRuntime(
  scheduling?: Scheduling,
  storage?: Storage,
  log?: Logger,
): SdkRuntime {
  return {
    onDispose,
    ...(log ? { log: ruleLog(log) } : {}),
    rule: registerTriggeredRule,
    setup: registerSetupRule,
    listen,
    onStartup,
    every,
    daily,
    cron,
    sun,
    ...(scheduling
      ? {
          sleep: scheduling.sleep,
          after: scheduling.after,
          randomInt: scheduling.randomInt,
          ...scheduling.sun,
        }
      : {}),
    ...(storage ? storageSdk(storage) : {}),
  };
}

/** Makes `runtime` the SDK seen by rule bundles. */
export function installSdkRuntime(runtime: SdkRuntime): void {
  (globalThis as Record<symbol, unknown>)[SDK_RUNTIME_KEY] = runtime;
}

export function installedSdkRuntime(): SdkRuntime | undefined {
  return (globalThis as Record<symbol, unknown>)[SDK_RUNTIME_KEY] as SdkRuntime | undefined;
}
