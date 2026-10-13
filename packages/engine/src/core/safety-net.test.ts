import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenario } from "./testing/run-scenario.js";

// Unhandled rejections inside vitest would fail the test run, so the scenario runs in its
// own Node process, bundled with esbuild.
describe("process safety net", () => {
  let dir: string;
  let entries: Array<Record<string, unknown>>;
  let exitCode: number;

  beforeAll(async () => {
    // Inside the package, so the bundle resolves its external packages (pino) normally.
    const cache = fileURLToPath(new URL("../../node_modules/.cache", import.meta.url));
    mkdirSync(cache, { recursive: true });
    dir = mkdtempSync(join(cache, "he-safety-"));
    ({ entries, exitCode } = await runScenario(
      dir,
      fileURLToPath(new URL("./testing/fixtures/safety-net-scenario.ts", import.meta.url)),
    ));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the engine running when a rule's floating promise rejects", () => {
    expect(exitCode).toBe(0);
    expect(entries).toContainEqual(expect.objectContaining({ message: "still running" }));
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "lights#porch",
        message: "Unhandled promise rejection",
        err: expect.objectContaining({ message: "floating rejection" }),
      }),
    );
  });

  it("attributes uncaught exceptions from rule timers to the rule", () => {
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "lights#porch",
        message: "Uncaught exception",
        err: expect.objectContaining({ message: "timer exception" }),
      }),
    );
  });

  it("logs a failed unawaited write with rule, service and message, but not handled writes", () => {
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "climate#heating",
        message:
          "Write failed (not awaited): light.turn_on → light.missing: Service light.turn_on: entity light.missing not found",
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("switch.turn_off");
  });

  it("records the error as the rule's last error", () => {
    expect(entries.find((e) => e.message === "still running")?.porchError).toBe("timer exception");
  });
});
