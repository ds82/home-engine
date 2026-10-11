import type { StateTrigger } from "@home-engine/sdk";
import { describe, expect, it } from "vitest";
import { logLoadSummary } from "./loader.js";
import type { RuleDefinition } from "./registration.js";
import { RuleRegistry } from "./rule-registry.js";
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
});
