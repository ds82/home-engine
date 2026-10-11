import type { RuleEvent, StateTrigger, Trigger } from "@home-engine/sdk";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { RuleDefinition } from "./registration.js";
import { listen, startRule } from "./rule-runner.js";
import { requireRun } from "./run-context.js";
import { FakeSources } from "./testing/fake-sources.js";
import { logCapture } from "./testing/log-capture.js";

const motion: StateTrigger = { kind: "state", entities: ["binary_sensor.motion"] };
const door: StateTrigger = { kind: "state", entities: ["binary_sensor.door"] };
const startup: Trigger = { kind: "startup" };

function triggered(
  body: (e: RuleEvent) => void | Promise<void>,
  options: Extract<RuleDefinition, { kind: "triggered" }>["options"] = {},
  triggers: Trigger | Trigger[] = motion,
): RuleDefinition {
  return {
    kind: "triggered",
    id: "test#rule",
    name: "rule",
    file: "test.ts",
    triggers,
    body,
    options,
  };
}

function setupRule(fn: () => unknown): RuleDefinition {
  return {
    kind: "setup",
    id: "test#setup",
    name: "setup",
    file: "test.ts",
    fn: fn as never,
    options: {},
  };
}

function env(setupTimeoutMs?: number) {
  const fake = new FakeSources();
  const capture = logCapture([]);
  const options = {
    sources: fake.sources,
    log: capture.log,
    ...(setupTimeoutMs ? { setupTimeoutMs } : {}),
  };
  return { fake, ...capture, start: (d: RuleDefinition) => startRule(d, options) };
}

/** A body that blocks until released; records start order. */
function gate() {
  const started: number[] = [];
  const releases: Array<() => void> = [];
  let n = 0;
  const body = async (e: RuleEvent): Promise<void> => {
    const id = ++n;
    started.push(id);
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      e.signal.addEventListener("abort", () => reject(e.signal.reason as Error));
    });
  };
  return { body, started, release: (i = 0) => releases[i]?.() };
}

const tick = (): Promise<void> => sleep(5);

describe("triggered rules", () => {
  it("arms every trigger and runs the body with the event, its trigger and a signal", async () => {
    const { fake, start } = env();
    const events: RuleEvent[] = [];
    const rule = await start(triggered((e) => void events.push(e), {}, [motion, door]));
    expect(rule.status).toBe("running");
    expect(fake.count).toBe(2);

    fake.change("binary_sensor.door");
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "state",
      entityId: "binary_sensor.door",
      trigger: door,
    });
    expect(events[0]?.signal).toBeInstanceOf(AbortSignal);

    await rule.stop();
    expect(fake.count).toBe(0);
    expect(fake.change("binary_sensor.door")).toBe(0);
  });

  it("fires startup triggers once after the rule started", async () => {
    const { start } = env();
    const types: string[] = [];
    await start(triggered((e) => void types.push(e.type), {}, [startup, motion]));
    await tick();
    expect(types).toEqual(["startup"]);
  });

  it("parallel (default) runs overlapping firings concurrently", async () => {
    const { fake, start } = env();
    const g = gate();
    await start(triggered(g.body));
    fake.change("binary_sensor.motion");
    fake.change("binary_sensor.motion");
    fake.change("binary_sensor.motion");
    await tick();
    expect(g.started).toEqual([1, 2, 3]);
  });

  it("parallel with max drops firings beyond the limit with a warning", async () => {
    const { fake, start, entries } = env();
    const g = gate();
    await start(triggered(g.body, { max: 2 }));
    for (let i = 0; i < 3; i++) fake.change("binary_sensor.motion");
    await tick();
    expect(g.started).toEqual([1, 2]);
    expect(entries()).toContainEqual(
      expect.objectContaining({ level: "warn", source: "test#rule" }),
    );
  });

  it("single drops a firing while the previous run is in progress, with a debug line", async () => {
    const { fake, start, entries } = env();
    const g = gate();
    await start(triggered(g.body, { mode: "single" }));
    fake.change("binary_sensor.motion");
    fake.change("binary_sensor.motion");
    await tick();
    expect(g.started).toEqual([1]);
    expect(entries()).toContainEqual(
      expect.objectContaining({
        level: "debug",
        message: expect.stringMatching(/Dropped a firing: mode single/),
      }),
    );
    g.release(0);
    await tick();
    fake.change("binary_sensor.motion");
    await tick();
    expect(g.started).toEqual([1, 2]);
  });

  it("queued runs firings one at a time in arrival order", async () => {
    const { fake, start } = env();
    const order: string[] = [];
    await start(
      triggered(
        async (e) => {
          const to = e.type === "state" ? e.to?.state : "";
          order.push(`start ${to}`);
          await sleep(5);
          order.push(`end ${to}`);
        },
        { mode: "queued" },
      ),
    );
    for (const v of ["a", "b", "c", "d"]) fake.change("binary_sensor.motion", v);
    await sleep(60);
    expect(order).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
      "start d",
      "end d",
    ]);
  });

  it("queued drops firings beyond max (default 10) with a warning", async () => {
    const { fake, start, entries } = env();
    const g = gate();
    await start(triggered(g.body, { mode: "queued" }));
    for (let i = 0; i < 11; i++) fake.change("binary_sensor.motion");
    await tick();
    expect(entries().filter((e) => e.level === "warn")).toHaveLength(1);
    expect(entries()).toContainEqual(expect.objectContaining({ level: "warn", max: 10 }));
  });

  it("restart aborts the running run without logging an error and starts anew", async () => {
    const { fake, start, entries } = env();
    let aborted = false;
    const starts: number[] = [];
    let n = 0;
    await start(
      triggered(
        async (e) => {
          starts.push(++n);
          try {
            await sleep(20 * 60_000, undefined, { signal: e.signal });
          } catch (err) {
            aborted = true;
            throw err;
          }
        },
        { mode: "restart" },
      ),
    );
    fake.change("binary_sensor.motion");
    await tick();
    fake.change("binary_sensor.motion");
    await tick();
    expect(starts).toEqual([1, 2]);
    expect(aborted).toBe(true);
    expect(entries().filter((e) => e.level === "error")).toEqual([]);
  });

  it("keeps triggers armed after a body throws", async () => {
    const { fake, start, entries } = env();
    let runs = 0;
    await start(
      triggered(() => {
        runs++;
        throw new TypeError("oops");
      }),
    );
    fake.change("binary_sensor.motion");
    fake.change("binary_sensor.motion");
    await tick();
    expect(runs).toBe(2);
    expect(entries().filter((e) => e.level === "error")).toHaveLength(2);
  });

  it("fails to start when no source exists for a trigger kind", async () => {
    const { start, fake } = env();
    const rule = await start(triggered(() => {}, {}, [motion, { kind: "sun", event: "sunset" }]));
    expect(rule.status).toBe("failed");
    expect(rule.error?.message).toMatch(/No trigger source for "sun"/);
    expect(fake.count).toBe(0);
  });
});

describe("setup rules", () => {
  it("runs the setup function once; listeners keep local state in closures", async () => {
    const { fake, start } = env();
    let presses = 0;
    let setups = 0;
    const rule = await start(
      setupRule(() => {
        setups++;
        listen(motion, () => {
          presses++;
        });
      }),
    );
    expect(rule.status).toBe("running");
    fake.change("binary_sensor.motion");
    fake.change("binary_sensor.motion");
    await tick();
    expect([setups, presses]).toEqual([1, 2]);
  });

  it("awaits an async setup function and counts as running once it resolves", async () => {
    const { fake, start } = env();
    let resolved = false;
    const rule = await start(
      setupRule(async () => {
        await sleep(10);
        listen(motion, () => {});
        resolved = true;
      }),
    );
    expect(resolved).toBe(true);
    expect(rule.status).toBe("running");
    expect(fake.count).toBe(1);
  });

  it("marks a throwing setup as failed and releases what it registered", async () => {
    const { fake, start, entries } = env();
    const rule = await start(
      setupRule(() => {
        listen(motion, () => {});
        throw new Error("setup broke");
      }),
    );
    expect(rule.status).toBe("failed");
    expect(rule.error?.message).toBe("setup broke");
    expect(fake.count).toBe(0);
    expect(entries()).toContainEqual(
      expect.objectContaining({ level: "error", source: "test#setup" }),
    );
  });

  it("fails a setup that does not settle in time, with a warning, and releases its resources", async () => {
    const { fake, start, entries } = env(30);
    const rule = await start(
      setupRule(async () => {
        listen(motion, () => {});
        await new Promise(() => {});
      }),
    );
    expect(rule.status).toBe("failed");
    expect(rule.error?.message).toMatch(/did not finish within/);
    expect(fake.count).toBe(0);
    expect(entries()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringMatching(/Setup of rule test#setup did not finish/),
      }),
    );
  });

  it("runs a returned teardown once when the rule is unloaded", async () => {
    const { start } = env();
    let teardowns = 0;
    const rule = await start(setupRule(() => () => void teardowns++));
    await rule.stop();
    await rule.stop();
    expect(teardowns).toBe(1);
  });

  it("runs listeners in parallel", async () => {
    const { fake, start } = env();
    const g = gate();
    await start(setupRule(() => void listen(motion, g.body)));
    fake.change("binary_sensor.motion");
    fake.change("binary_sensor.motion");
    await tick();
    expect(g.started).toEqual([1, 2]);
  });

  it("cancels a single listener while the others stay active", async () => {
    const { fake, start } = env();
    const calls: string[] = [];
    await start(
      setupRule(() => {
        const handle = listen(motion, () => void calls.push("a"));
        listen(motion, () => void calls.push("b"));
        handle.cancel();
        handle.cancel();
      }),
    );
    fake.change("binary_sensor.motion");
    await tick();
    expect(calls).toEqual(["b"]);
  });

  it("allows listen() from listener callbacks of the same setup rule", async () => {
    const { fake, start } = env();
    const calls: string[] = [];
    await start(
      setupRule(() => {
        listen(motion, () => {
          listen(door, () => void calls.push("door"));
        });
      }),
    );
    fake.change("binary_sensor.motion");
    await tick();
    fake.change("binary_sensor.door");
    await tick();
    expect(calls).toEqual(["door"]);
  });

  it("fires startup listeners registered during setup after setup finished; later ones throw", async () => {
    const { fake, start, entries } = env();
    const order: string[] = [];
    await start(
      setupRule(async () => {
        listen(startup, () => void order.push("startup listener"));
        await sleep(5);
        order.push("setup done");
        listen(motion, () => {
          listen(startup, () => {});
        });
      }),
    );
    await tick();
    expect(order).toEqual(["setup done", "startup listener"]);
    fake.change("binary_sensor.motion");
    await tick();
    expect(entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({ message: "onStartup() can only be used during setup." }),
      }),
    );
  });
});

describe("listen() outside setup rules", () => {
  it("throws at top level", () => {
    expect(() => listen(motion, () => {})).toThrow("listen() is only available in setup rules");
  });

  it("throws inside a triggered rule's body, and the error is logged for that run", async () => {
    const { fake, start, entries } = env();
    await start(triggered(() => void listen(door, () => {})));
    fake.change("binary_sensor.motion");
    await tick();
    expect(entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "test#rule",
        err: expect.objectContaining({
          message: expect.stringMatching(/only available in setup rules/),
        }),
      }),
    );
  });

  it("gives every run of a listener its own signal", async () => {
    const { fake, start } = env();
    const signals: AbortSignal[] = [];
    await start(
      setupRule(() => void listen(motion, () => void signals.push(requireRun("x").signal))),
    );
    fake.change("binary_sensor.motion");
    fake.change("binary_sensor.motion");
    await tick();
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});
