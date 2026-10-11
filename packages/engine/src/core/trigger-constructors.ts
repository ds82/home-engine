// Core trigger constructors. Like all constructors they only build a frozen descriptor;
// the engine arms it when the rule starts.

import type { StartupTrigger } from "@home-engine/sdk";

/** SDK `onStartup()`: fires once each time the rule starts. */
export function onStartup(...args: unknown[]): StartupTrigger {
  if (args.length > 0) throw new TypeError("onStartup() takes no arguments");
  return Object.freeze({ kind: "startup" });
}
