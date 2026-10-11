import type { ListenerHandle, RuleEvent, Trigger } from "@home-engine/sdk";
import { describe, expect, it } from "vitest";
import type { RuleDefinition } from "./registration.js";
import { RuleRegistry } from "./rule-registry.js";
import { listen } from "./rule-runner.js";
import { createScheduling } from "./scheduling.js";
import { FakeClock } from "./testing/fake-clock.js";
import { logCapture } from "./testing/log-capture.js";
import { daily, every, onStartup, sun } from "./trigger-constructors.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function env(startIso: string) {
  const clock = new FakeClock(Date.parse(startIso));
  const scheduling = createScheduling({
    clock,
    timeZone: () => "Europe/Berlin",
    location: () => ({ latitude: 52.52, longitude: 13.405, elevation: 34 }),
  });
  const registry = new RuleRegistry({ sources: scheduling.sources, log: logCapture([]).log });
  return { clock, registry };
}

function triggered(triggers: Trigger | Trigger[], runs: RuleEvent[] = []): RuleDefinition {
  return {
    kind: "triggered",
    id: "morning#wake",
    name: "wake",
    file: "morning.ts",
    triggers,
    body: (e) => void runs.push(e),
    options: {},
  };
}

describe("next run reporting", () => {
  it("reports today's 07:00 as the next run when inspected at 06:00", async () => {
    // 04:00 UTC is 06:00 in Berlin.
    const { clock, registry } = env("2026-10-11T04:00:00.000Z");
    await registry.loadFile("morning.ts", [triggered(daily("07:00"))]);
    expect(registry.rule("morning#wake")?.nextRun?.toISOString()).toBe("2026-10-11T05:00:00.000Z");

    clock.advance(60 * 60_000);
    await tick();
    expect(registry.rule("morning#wake")?.nextRun?.toISOString()).toBe("2026-10-12T05:00:00.000Z");
  });

  it("lists the next run of every time trigger and reports the earliest", async () => {
    const { registry } = env("2026-10-11T04:00:00.000Z");
    await registry.loadFile("morning.ts", [
      triggered([onStartup(), daily("07:00"), every("15m"), sun("sunset")]),
    ]);
    const info = registry.rule("morning#wake");
    expect(info?.nextRuns.map((n) => n.kind)).toEqual(["daily", "every", "sun"]);
    expect(info?.nextRun?.toISOString()).toBe("2026-10-11T04:15:00.000Z");
  });

  it("reports the next run on listener handles of setup rules", async () => {
    const { registry } = env("2026-10-11T04:00:00.000Z");
    const handles: ListenerHandle[] = [];
    await registry.loadFile("morning.ts", [
      {
        kind: "setup",
        id: "morning#setup",
        name: "setup",
        file: "morning.ts",
        options: {},
        fn: () => {
          handles.push(listen(daily("07:00"), () => {}));
          handles.push(listen(onStartup(), () => {}));
        },
      },
    ]);
    const [timed, startup] = handles;
    expect(timed?.nextRun?.toISOString()).toBe("2026-10-11T05:00:00.000Z");
    expect(startup?.nextRun).toBeUndefined();
    expect(registry.rule("morning#setup")?.nextRun?.toISOString()).toBe("2026-10-11T05:00:00.000Z");
    timed?.cancel();
    expect(timed?.nextRun).toBeUndefined();
    expect(registry.rule("morning#setup")?.nextRun).toBeUndefined();
  });

  it("cancels all schedules when the rule is unloaded", async () => {
    const { clock, registry } = env("2026-10-11T04:00:00.000Z");
    const runs: RuleEvent[] = [];
    await registry.loadFile("morning.ts", [triggered([daily("07:00"), every("1m")], runs)]);
    await registry.unloadFile("morning.ts");
    clock.advance(24 * 60 * 60_000);
    await tick();
    expect(runs).toEqual([]);
  });

  it("does not replay a schedule missed while the engine was down", async () => {
    // The engine was stopped from 06:55 to 07:05; the rule loads at 07:05 Berlin.
    const { clock, registry } = env("2026-10-11T05:05:00.000Z");
    const runs: RuleEvent[] = [];
    await registry.loadFile("morning.ts", [triggered(daily("07:00"), runs)]);
    clock.advance(60_000);
    await tick();
    expect(runs).toEqual([]);
    expect(registry.rule("morning#wake")?.nextRun?.toISOString()).toBe("2026-10-12T05:00:00.000Z");
  });
});
