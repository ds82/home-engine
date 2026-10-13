// Spike for design decision 2 of fix-spec-audit-gaps: an AsyncLocalStorage store set around
// the dynamic import of a bundled rule file follows the file's evaluation, including
// top-level await and native timers created there. File registration relies on it.

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundleRuleFile, importBundle } from "./bundler.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";

const PROBE = "__homeEngineContextProbe";

describe("AsyncLocalStorage across a rule file's evaluation", () => {
  let root: string;

  beforeAll(() => installSdkRuntime(coreSdkRuntime()));
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    Reflect.deleteProperty(globalThis, PROBE);
  });

  it("is visible at top level, after top-level await and in timers created there", async () => {
    root = mkdtempSync(join(tmpdir(), "he-context-"));
    const rulesDir = join(root, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, "probe.ts"),
      [
        `declare const ${PROBE}: (where: string) => void;`,
        `${PROBE}("top level");`,
        "await new Promise((resolve) => setTimeout(resolve, 5));",
        `${PROBE}("after await");`,
        `setTimeout(() => ${PROBE}("timer"), 1);`,
        `queueMicrotask(() => ${PROBE}("microtask"));`,
      ].join("\n"),
    );
    const storage = new AsyncLocalStorage<string>();
    const seen: Array<[string, string | undefined]> = [];
    let timerSeen!: () => void;
    const timerFired = new Promise<void>((resolve) => (timerSeen = resolve));
    (globalThis as Record<string, unknown>)[PROBE] = (where: string) => {
      seen.push([where, storage.getStore()]);
      if (where === "timer") {
        timerSeen();
      }
    };

    const bundle = await bundleRuleFile({ rulesDir, file: "probe.ts", buildDir: join(root, "b") });
    await storage.run("probe.ts", () => importBundle(bundle.outfile));
    expect(storage.getStore()).toBeUndefined();
    await timerFired;

    expect(seen).toEqual([
      ["top level", "probe.ts"],
      ["after await", "probe.ts"],
      ["microtask", "probe.ts"],
      ["timer", "probe.ts"],
    ]);
  });
});
