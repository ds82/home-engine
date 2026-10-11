import type { RuleEvent, TimeEvent } from "@home-engine/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleDefinition } from "./registration.js";
import { startRule } from "./rule-runner.js";
import { RuleScopeImpl } from "./rule-scope.js";
import { invoke } from "./run-context.js";
import { createScheduling } from "./scheduling.js";
import { FakeClock } from "./testing/fake-clock.js";
import { logCapture } from "./testing/log-capture.js";
import { every } from "./trigger-constructors.js";

const MIN = 60_000;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup(start?: number, timeZone = "Europe/Berlin") {
  const clock = new FakeClock(start);
  const scheduling = createScheduling({ clock, timeZone: () => timeZone });
  const capture = logCapture([]);
  const scope = new RuleScopeImpl("test#rule", capture.log);
  return { clock, scheduling, scope, capture };
}

describe("sleep", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves after the duration", async () => {
    const { clock, scheduling, scope } = setup();
    let done = false;
    invoke(scope, "body", async () => {
      await scheduling.sleep("10m");
      done = true;
    });
    clock.advance(10 * MIN - 1);
    await tick();
    expect(done).toBe(false);
    clock.advance(1);
    await tick();
    expect(done).toBe(true);
  });

  it("throws at the call site for a malformed duration", async () => {
    const { scheduling, scope } = setup();
    let message = "";
    await invoke(scope, "body", () => {
      try {
        void scheduling.sleep("5 minutes");
      } catch (err) {
        message = (err as Error).message;
      }
    }).done;
    expect(message).toMatch(/Invalid sleep\(\) duration: "5 minutes"/);
  });

  it("never continues past the sleep when the rule is unloaded", async () => {
    const { clock, scheduling, scope, capture } = setup();
    let continued = false;
    const run = invoke(scope, "body", async () => {
      await scheduling.sleep("1h");
      continued = true;
    });
    clock.advance(5 * MIN);
    await scope.dispose();
    await run.done;
    clock.advance(2 * 60 * MIN);
    await tick();
    expect(continued).toBe(false);
    expect(capture.entries().filter((e) => e.level === "error")).toEqual([]);
  });

  it("rejects when the run is aborted (restart)", async () => {
    const { scheduling, scope } = setup();
    let error: unknown;
    const run = invoke(scope, "body", async () => {
      try {
        await scheduling.sleep("20m");
      } catch (err) {
        error = err;
      }
    });
    run.abort();
    await run.done;
    expect((error as Error).name).toBe("AbortError");
  });

  it("supports a random delay with randomInt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { clock, scheduling, scope } = setup();
    let done = false;
    invoke(scope, "body", async () => {
      await scheduling.sleep(`${scheduling.randomInt(1, 30)}m`);
      done = true;
    });
    clock.advance(16 * MIN - 1);
    await tick();
    expect(done).toBe(false);
    clock.advance(1);
    await tick();
    expect(done).toBe(true);
  });
});

describe("randomInt", () => {
  it("returns integers within both bounds and validates them", () => {
    const { scheduling } = setup();
    const values = new Set(Array.from({ length: 500 }, () => scheduling.randomInt(1, 3)));
    expect([...values].sort()).toEqual([1, 2, 3]);
    expect(scheduling.randomInt(5, 5)).toBe(5);
    expect(() => scheduling.randomInt(3, 1)).toThrow(/min <= max/);
    expect(() => scheduling.randomInt(1.5, 3)).toThrow(/integers/);
  });
});

describe("after", () => {
  it("runs the callback once after the delay and reports its next run", async () => {
    const { clock, scheduling, scope } = setup();
    let runs = 0;
    let handle: ReturnType<typeof scheduling.after> | undefined;
    await invoke(scope, "setup", () => {
      handle = scheduling.after("10m", () => void runs++);
    }).done;
    expect(handle?.nextRun?.getTime()).toBe(clock.now() + 10 * MIN);
    clock.advance(10 * MIN);
    await tick();
    clock.advance(60 * MIN);
    await tick();
    expect(runs).toBe(1);
    expect(handle?.nextRun).toBeUndefined();
  });

  it("can be cancelled through its handle", async () => {
    const { clock, scheduling, scope } = setup();
    let runs = 0;
    await invoke(scope, "setup", () => {
      scheduling.after("10m", () => void runs++).cancel();
    }).done;
    clock.advance(20 * MIN);
    await tick();
    expect(runs).toBe(0);
  });

  it("is cancelled on unload and when its run is aborted", async () => {
    const { clock, scheduling, scope } = setup();
    let runs = 0;
    const restarted = invoke(scope, "body", () => {
      scheduling.after("10m", () => void runs++);
    });
    await restarted.done;
    restarted.abort();
    await invoke(scope, "setup", () => {
      scheduling.after("10m", () => void runs++);
    }).done;
    await scope.dispose();
    clock.advance(20 * MIN);
    await tick();
    expect(runs).toBe(0);
  });

  it("logs a throwing callback with the rule ID", async () => {
    const { clock, scheduling, scope, capture } = setup();
    await invoke(scope, "setup", () => {
      scheduling.after("1m", () => {
        throw new Error("callback broke");
      });
    }).done;
    clock.advance(MIN);
    await tick();
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "test#rule",
        err: expect.objectContaining({ message: "callback broke" }),
      }),
    );
  });
});

describe("every", () => {
  async function arm(
    clock: FakeClock,
    scheduling: ReturnType<typeof createScheduling>,
    trigger: ReturnType<typeof every>,
  ) {
    const events: TimeEvent[] = [];
    const definition: RuleDefinition = {
      kind: "triggered",
      id: "test#every",
      name: "every",
      file: "test.ts",
      triggers: trigger,
      body: (e: RuleEvent) => void (e.type === "time" && events.push(e)),
      options: {},
    };
    const rule = await startRule(definition, {
      sources: { every: scheduling.everySource },
      log: logCapture([]).log,
    });
    return { events, rule };
  }

  it("fires every 15 minutes until the rule is unloaded", async () => {
    const { clock, scheduling } = setup();
    const start = clock.now();
    const { events, rule } = await arm(clock, scheduling, every("15m"));
    for (let i = 0; i < 4; i++) {
      clock.advance(15 * MIN);
      await tick();
    }
    expect(events.map((e) => (e.scheduledAt.getTime() - start) / MIN)).toEqual([15, 30, 45, 60]);
    await rule.stop();
    clock.advance(60 * MIN);
    await tick();
    expect(events).toHaveLength(4);
  });

  it("also fires right after start with immediate", async () => {
    const { clock, scheduling } = setup();
    const { events } = await arm(clock, scheduling, every("1h", { immediate: true }));
    await tick();
    expect(events).toHaveLength(1);
    clock.advance(60 * MIN);
    await tick();
    expect(events).toHaveLength(2);
  });

  it("aligns the grid to a local time in the Site's time zone", async () => {
    // 04:50 UTC is 06:50 in Berlin (CEST).
    const { clock, scheduling } = setup(Date.parse("2026-10-11T04:50:00.000Z"));
    const { events } = await arm(clock, scheduling, every("15m", { alignTo: "07:00" }));
    clock.advance(30 * MIN);
    await tick();
    expect(events.map((e) => e.scheduledAt.toISOString())).toEqual([
      "2026-10-11T05:00:00.000Z",
      "2026-10-11T05:15:00.000Z",
    ]);
  });

  it("validates its arguments", () => {
    expect(() => every("15 minutes")).toThrow(/Invalid every\(\) interval/);
    expect(() => every(0)).toThrow(/longer than 0/);
    expect(() => every("1h", { alignTo: "7am" })).toThrow(/not a time/);
    expect(() => every("1h", { start: "07:00" })).toThrow(/unknown option "start"/);
    expect(Object.isFrozen(every("1h"))).toBe(true);
  });
});
