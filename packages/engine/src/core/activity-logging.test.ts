import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateTrigger } from "@home-engine/sdk";
import { describe, expect, it } from "vitest";
import { RuleLoader, logLoadSummary } from "./loader.js";
import type { RuleDefinition } from "./registration.js";
import { RuleRegistry } from "./rule-registry.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";
import { FakeSources } from "./testing/fake-sources.js";
import { logCapture } from "./testing/log-capture.js";

const motion: StateTrigger = { kind: "state", entities: ["binary_sensor.motion"] };

const def = (name: string): RuleDefinition => ({
  kind: "triggered",
  id: `rooms#${name}`,
  name,
  file: "rooms.ts",
  triggers: motion,
  body: () => {},
  options: {},
});

describe("engine activity logging", () => {
  it("summarises the initial load as loaded, disabled and failed", async () => {
    const capture = logCapture([]);
    const reg = new RuleRegistry({ sources: new FakeSources().sources, log: capture.log }, [
      "rooms#disabled",
    ]);
    const rules = Array.from({ length: 12 }, (_, i) => def(`r${i}`));
    await reg.loadFile("rooms.ts", [...rules, def("disabled")]);
    reg.fileFailed("broken.ts", new SyntaxError("Unexpected token"));
    logLoadSummary(reg, capture.log);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Rules: 12 loaded, 1 disabled, 1 failed",
        loaded: 12,
        disabled: 1,
        failed: 1,
      }),
    );
  });

  it("traces every trigger firing at debug level with the rule ID", async () => {
    const capture = logCapture([]);
    capture.log.level = "debug";
    const fake = new FakeSources();
    const reg = new RuleRegistry({ sources: fake.sources, log: capture.log });
    await reg.loadFile("rooms.ts", [def("hall")]);
    fake.change("binary_sensor.motion");
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "debug",
        source: "rooms#hall",
        message: "state trigger fired (binary_sensor.motion)",
        trigger: "state",
        entityId: "binary_sensor.motion",
      }),
    );
  });

  it("does not trace firings at info level", async () => {
    const capture = logCapture([]);
    capture.log.level = "info";
    const fake = new FakeSources();
    const reg = new RuleRegistry({ sources: fake.sources, log: capture.log });
    await reg.loadFile("rooms.ts", [def("hall")]);
    fake.change("binary_sensor.motion");
    expect(capture.entries().filter((e) => String(e.message).includes("fired"))).toEqual([]);
  });

  it("logs rule starts, stops and setup problems with the rule ID, file lines as the engine", async () => {
    const capture = logCapture([]);
    capture.log.level = "debug";
    const reg = new RuleRegistry({
      sources: new FakeSources().sources,
      log: capture.log,
      setupTimeoutMs: 20,
    });
    const setup = (name: string, fn: () => unknown): RuleDefinition => ({
      kind: "setup",
      id: `rooms#${name}`,
      name,
      file: "rooms.ts",
      fn: fn as () => void,
      options: {},
    });
    await reg.loadFile("rooms.ts", [
      def("hall"),
      setup("broken", () => {
        throw new Error("no lamp");
      }),
      setup("slow", () => new Promise(() => {})),
    ]);
    await reg.unloadFile("rooms.ts");
    const lines = capture.entries().map((e) => [e.level, e.source, e.message]);
    expect(lines).toEqual(
      expect.arrayContaining([
        ["debug", "rooms#hall", "Rule started"],
        ["error", "rooms#broken", "Rule setup failed"],
        ["warn", "rooms#slow", "Setup of rule rooms#slow did not finish within 0.02 s"],
        ["debug", "rooms#hall", "Rule stopped"],
      ]),
    );
    expect(lines.filter(([, , m]) => m === "Rule stopped")).toHaveLength(1);
  });

  it("logs file loads as the engine", async () => {
    const capture = logCapture([]);
    installSdkRuntime(coreSdkRuntime());
    const root = mkdtempSync(join(tmpdir(), "he-activity-"));
    try {
      mkdirSync(join(root, "rules"));
      writeFileSync(
        join(root, "rules", "rooms.ts"),
        'import { rule } from "@home-engine/sdk";\nrule("hall", { kind: "startup" }, () => {});\n',
      );
      const reg = new RuleRegistry({ sources: new FakeSources().sources, log: capture.log });
      const loader = new RuleLoader({
        rulesDir: join(root, "rules"),
        buildDir: join(root, "build"),
        registry: reg,
        log: capture.log,
      });
      await loader.loadAll();
      await loader.unloadFile("rooms.ts");
      expect(capture.entries()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "engine", message: "Loaded rooms.ts (1 rule(s))" }),
          expect.objectContaining({ source: "engine", message: "Unloaded rooms.ts" }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
