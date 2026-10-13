import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenario } from "../../core/testing/run-scenario.js";

// ha-actions: Unawaited write errors are reported, for the switching helpers too.
describe("unawaited switching writes", () => {
  let dir: string;
  let entries: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // Inside the package, so the bundle resolves its external packages normally.
    const cache = fileURLToPath(new URL("../../../node_modules/.cache", import.meta.url));
    mkdirSync(cache, { recursive: true });
    dir = mkdtempSync(join(cache, "he-writes-"));
    ({ entries } = await runScenario(
      dir,
      fileURLToPath(new URL("./testing/fixtures/switching-write-scenario.ts", import.meta.url)),
    ));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("logs a failed unawaited forceOn once, attributed to the rule, like a service call", () => {
    const failed = entries.filter((e) => String(e.message).startsWith("Write failed"));
    expect(failed).toEqual([
      expect.objectContaining({
        level: "error",
        source: "lights#hall",
        message: expect.stringMatching(
          /^Write failed \(not awaited\): light\.turn_on → light\.missing: .*Entity light\.missing not found/,
        ),
      }),
    ]);
    expect(entries).toContainEqual(expect.objectContaining({ message: "done" }));
    expect(entries.filter((e) => e.message === "Unhandled promise rejection")).toEqual([]);
  });
});
