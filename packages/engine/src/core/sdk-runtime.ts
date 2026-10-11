// The engine-side implementation of `@home-engine/sdk`. Rule bundles import the SDK through a
// virtual module (see bundler.ts) that reads this object from `globalThis`, so every rule
// shares the engine's single instance. Backend adapters add their functions to it.

import { registerSetupRule, registerTriggeredRule } from "./registration.js";
import { listen } from "./rule-runner.js";
import type { Scheduling } from "./scheduling.js";
import { cron, daily, every, onStartup } from "./trigger-constructors.js";

export const SDK_RUNTIME_KEY = Symbol.for("home-engine.sdk");

export type SdkRuntime = Record<string, unknown>;

/** The core's SDK functions; adapters extend this object with their own. */
export function coreSdkRuntime(scheduling?: Scheduling): SdkRuntime {
  return {
    rule: registerTriggeredRule,
    setup: registerSetupRule,
    listen,
    onStartup,
    every,
    daily,
    cron,
    ...(scheduling
      ? { sleep: scheduling.sleep, after: scheduling.after, randomInt: scheduling.randomInt }
      : {}),
  };
}

/** Makes `runtime` the SDK seen by rule bundles. */
export function installSdkRuntime(runtime: SdkRuntime): void {
  (globalThis as Record<symbol, unknown>)[SDK_RUNTIME_KEY] = runtime;
}

export function installedSdkRuntime(): SdkRuntime | undefined {
  return (globalThis as Record<symbol, unknown>)[SDK_RUNTIME_KEY] as SdkRuntime | undefined;
}
