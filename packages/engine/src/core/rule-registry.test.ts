import type { StateTrigger } from "@home-engine/sdk";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { RuleDefinition } from "./registration.js";
import { RuleRegistry, matchesRulePattern } from "./rule-registry.js";
import { listen } from "./rule-runner.js";
import { FakeSources } from "./testing/fake-sources.js";
import { logCapture } from "./testing/log-capture.js";

const motion: StateTrigger = { kind: "state", entities: ["binary_sensor.motion"] };

function def(
  file: string,
  name: string,
  overrides: Partial<Extract<RuleDefinition, { kind: "triggered" }>> = {},
): RuleDefinition {
  const id = `${file.replace(/\.ts$/, "")}#${name}`;
  return {
    kind: "triggered",
    id,
    name,
    file,
    triggers: motion,
    body: () => {},
    options: {},
    ...overrides,
  };
}

function registry(disabled: string[] = []) {
  const fake = new FakeSources();
  return {
    fake,
    reg: new RuleRegistry({ sources: fake.sources, log: logCapture([]).log }, disabled),
  };
}

describe("matchesRulePattern", () => {
  it.each([
    ["lights/*", "lights/hallway#motion", true],
    ["lights/*", "lightsaber#x", false],
    ["climate#heating", "climate#heating", true],
    ["climate#heating", "climate#heating2", false],
    ["*#motion", "rooms/kitchen#motion", true],
    ["kitchen-?", "kitchen-1", true],
    ["a.b", "axb", false],
  ])("%s matches %s: %s", (pattern, id, expected) => {
    expect(matchesRulePattern(pattern, id)).toBe(expected);
  });
});

describe("RuleRegistry", () => {
  it("starts a file's rules and reports them as running with load time", async () => {
    const { reg, fake } = registry();
    await reg.loadFile("lights.ts", [def("lights.ts", "a"), def("lights.ts", "b")]);
    expect(fake.count).toBe(2);
    expect(reg.listRules().map((r) => [r.id, r.status])).toEqual([
      ["lights#a", "running"],
      ["lights#b", "running"],
    ]);
    expect(reg.rule("lights#a")?.loadedAt).toBeInstanceOf(Date);
    expect(reg.listFiles()).toEqual([
      expect.objectContaining({ file: "lights.ts", status: "loaded", error: undefined }),
    ]);
  });

  it("registers rules with enabled: false as disabled and never arms them", async () => {
    const { reg, fake } = registry();
    await reg.loadFile("x.ts", [def("x.ts", "off", { options: { enabled: false } })]);
    expect(fake.count).toBe(0);
    expect(reg.rule("x#off")).toMatchObject({ status: "disabled", disabledBy: "option" });
  });

  it("disables matching rules via DISABLED_RULES patterns, regardless of their options", async () => {
    const { reg, fake } = registry(["lights/*", "climate#heating"]);
    await reg.loadFile("lights/hallway.ts", [
      def("lights/hallway.ts", "motion", { options: { enabled: true } }),
    ]);
    await reg.loadFile("climate.ts", [def("climate.ts", "heating"), def("climate.ts", "cooling")]);
    expect(reg.listRules().map((r) => [r.id, r.status, r.disabledBy])).toEqual([
      ["lights/hallway#motion", "disabled", "config"],
      ["climate#heating", "disabled", "config"],
      ["climate#cooling", "running", undefined],
    ]);
    expect(fake.count).toBe(1);
  });

  it("reports a failed setup with its last error", async () => {
    const { reg } = registry();
    await reg.loadFile("s.ts", [
      {
        kind: "setup",
        id: "s#broken",
        name: "broken",
        file: "s.ts",
        options: {},
        fn: () => {
          throw new Error("setup broke");
        },
      },
    ]);
    expect(reg.rule("s#broken")).toMatchObject({ status: "failed", lastError: "setup broke" });
  });

  it("tracks the last run time and the last body error", async () => {
    const { reg, fake } = registry();
    await reg.loadFile("r.ts", [
      def("r.ts", "flaky", {
        body: () => {
          throw new Error("body broke");
        },
      }),
    ]);
    expect(reg.rule("r#flaky")?.lastRunAt).toBeUndefined();
    fake.change("binary_sensor.motion");
    await sleep(5);
    expect(reg.rule("r#flaky")).toMatchObject({ status: "running", lastError: "body broke" });
    expect(reg.rule("r#flaky")?.lastRunAt).toBeInstanceOf(Date);
  });

  it("unloads a file's rules", async () => {
    const { reg, fake } = registry();
    await reg.loadFile("a.ts", [def("a.ts", "x")]);
    await reg.loadFile("b.ts", [def("b.ts", "y")]);
    await reg.unloadFile("a.ts");
    expect(fake.count).toBe(1);
    expect(reg.listRules().map((r) => r.id)).toEqual(["b#y"]);
    await reg.unloadAll();
    expect(fake.count).toBe(0);
    expect(reg.listFiles()).toEqual([]);
  });

  it("records files that failed to load with their error", () => {
    const { reg } = registry();
    reg.fileFailed("broken.ts", new Error("SyntaxError: Unexpected token"));
    expect(reg.listFiles()).toEqual([
      expect.objectContaining({
        file: "broken.ts",
        status: "failed",
        error: "SyntaxError: Unexpected token",
      }),
    ]);
  });

  it("fails the second file using an explicit ID and keeps the first running", async () => {
    const { reg, fake } = registry();
    await reg.loadFile("kitchen.ts", [def("kitchen.ts", "motion", { id: "kitchen-motion" })]);
    await reg.loadFile("other.ts", [
      def("other.ts", "a"),
      def("other.ts", "motion", { id: "kitchen-motion" }),
    ]);
    expect(fake.count).toBe(1);
    expect(reg.rule("kitchen-motion")).toMatchObject({ file: "kitchen.ts", status: "running" });
    const other = reg.listFiles().find((f) => f.file === "other.ts");
    expect(other).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/kitchen-motion.*other\.ts.*kitchen\.ts/),
    });
  });

  it("reports a setup rule as starting until its async setup resolves", async () => {
    const { reg, fake } = registry();
    let release: () => void = () => {};
    const heard: string[] = [];
    const loading = reg.loadFile("counter.ts", [
      {
        kind: "setup",
        id: "counter#count",
        name: "count",
        file: "counter.ts",
        options: {},
        fn: async () => {
          listen(motion, () => void heard.push("motion"));
          await new Promise<void>((r) => (release = r)); // a slow service call
        },
      },
      def("counter.ts", "after"),
    ]);
    await sleep(5);
    expect(reg.rule("counter#count")).toMatchObject({ status: "starting", activeTriggers: 1 });
    expect(reg.summary()).toEqual({ loaded: 1, disabled: 0, failed: 0 });

    // The listener registered before the await already fires.
    fake.change("binary_sensor.motion");
    await sleep(5);
    expect(heard).toEqual(["motion"]);

    release();
    await loading;
    expect(reg.rule("counter#count")).toMatchObject({ status: "running" });
    expect(reg.rule("counter#after")).toMatchObject({ status: "running" });
  });

  it("never reports a triggered rule as starting", async () => {
    const { reg } = registry();
    const loading = reg.loadFile("t.ts", [def("t.ts", "x")]);
    expect(reg.rule("t#x")?.status).not.toBe("starting");
    await loading;
    expect(reg.rule("t#x")?.status).toBe("running");
  });
});
