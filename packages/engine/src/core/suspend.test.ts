// Time triggers after a host suspend (rule-scheduler: Clock drift and sleep robustness).
// The FakeHost's wall clock jumps while its timers stand still, as when the host sleeps:
// missed runs are skipped and logged at debug level, never replayed.

import type { RuleEvent, Trigger } from "@home-engine/sdk";
import { describe, expect, it } from "vitest";
import type { RuleDefinition } from "./registration.js";
import { startRule } from "./rule-runner.js";
import { createScheduling } from "./scheduling.js";
import { nextSunEvent, type Location } from "./sun.js";
import { FakeHost } from "./testing/fake-host.js";
import { logCapture } from "./testing/log-capture.js";
import { hostClock, MAX_ARM_MS } from "./timer.js";
import { cron, daily, every, sun } from "./trigger-constructors.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BERLIN: Location = { latitude: 52.52, longitude: 13.405, elevation: 34 };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function arm(trigger: Trigger, startIso: string) {
  const host = new FakeHost(Date.parse(startIso));
  const scheduling = createScheduling({
    clock: hostClock(host),
    timeZone: () => "Europe/Berlin",
    location: () => BERLIN,
  });
  const capture = logCapture([]);
  const runs: string[] = [];
  const definition: RuleDefinition = {
    kind: "triggered",
    id: "test#suspend",
    name: "suspend",
    file: "test.ts",
    triggers: trigger,
    body: (e: RuleEvent) => {
      if (e.type === "time" || e.type === "sun") {
        runs.push(e.scheduledAt.toISOString());
      }
    },
    options: {},
  };
  await startRule(definition, { sources: scheduling.sources, log: capture.log });
  return {
    host,
    runs,
    skipped: () => capture.entries().filter((e) => String(e.message).startsWith("Skipped")),
    errors: () => capture.entries().filter((e) => e.level === "error"),
    elapse: async (ms: number) => {
      host.elapse(ms);
      await tick();
    },
    /** Suspends the host until `iso` (wall clock) and lets it notice the wake-up. */
    suspendUntil: async (iso: string) => {
      host.jump(Date.parse(iso) - host.now());
      host.elapse(MAX_ARM_MS);
      await tick();
    },
  };
}

describe("time triggers after a host suspend", () => {
  it("daily skips the missed days, logs the skip at debug level and runs next on time", async () => {
    // Monday 06:00 Berlin, suspended until Thursday 05:00.
    const t = await arm(daily("07:00"), "2026-10-12T04:00:00.000Z");
    await t.elapse(10 * MIN);
    await t.suspendUntil("2026-10-15T03:00:00.000Z");
    expect(t.runs).toEqual([]);
    expect(t.skipped()).toEqual([
      expect.objectContaining({ level: "debug", source: "test#suspend" }),
    ]);
    expect(String(t.skipped()[0]?.message)).toMatch(
      /^Skipped daily\("07:00"\) run planned for 2026-10-12T05:00:00\.000Z: \d+h late$/,
    );
    await t.elapse(3 * HOUR);
    expect(t.runs).toEqual(["2026-10-15T05:00:00.000Z"]);
  });

  it("cron skips the missed runs and runs next at the first match after the wake-up", async () => {
    const t = await arm(cron("0 */2 * * *"), "2026-10-12T04:10:00.000Z");
    await t.suspendUntil("2026-10-15T03:00:00.000Z"); // Thursday 05:00 Berlin
    expect(t.runs).toEqual([]);
    expect(t.skipped()).toHaveLength(1);
    await t.elapse(HOUR + MIN);
    expect(t.runs).toEqual(["2026-10-15T04:00:00.000Z"]); // 06:00 Berlin
  });

  it("every keeps running after three days and resumes on its grid", async () => {
    const start = Date.parse("2026-10-11T06:00:00.000Z");
    const t = await arm(every("1m"), new Date(start).toISOString());
    await t.elapse(10 * SEC);
    // The engine notices the wake-up 3 days, 1 minute and 15 seconds after the start.
    await t.suspendUntil(new Date(start + 3 * DAY + 25 * SEC).toISOString());
    expect(t.runs).toEqual([]);
    expect(t.errors()).toEqual([]);
    expect(t.skipped()).toHaveLength(1);
    await t.elapse(MIN);
    expect(t.runs).toEqual([new Date(start + 3 * DAY + 2 * MIN).toISOString()]);
  });

  it("sun skips the missed sunsets and runs at the first sunset after the wake-up", async () => {
    const t = await arm(sun("sunset"), "2026-10-12T10:00:00.000Z");
    await t.suspendUntil("2026-10-15T10:00:00.000Z");
    expect(t.runs).toEqual([]);
    expect(t.skipped()).toHaveLength(1);
    await t.elapse(12 * HOUR);
    const sunset = nextSunEvent("sunset", t.host.now() - 12 * HOUR, BERLIN, "Europe/Berlin");
    expect(t.runs).toEqual([new Date(sunset ?? NaN).toISOString()]);
  });

  /** Brings a daily("07:00") timer due at 07:00 and delays its wake-up by `lateMs`. */
  async function lateBy(lateMs: number) {
    const t = await arm(daily("07:00"), "2026-10-12T04:00:00.000Z"); // 06:00 Berlin
    await t.elapse(59 * MIN + 50 * SEC);
    t.host.jump(lateMs); // a busy event loop: the wall clock moves, the timer waits
    await t.elapse(10 * SEC);
    return t;
  }

  it("still runs a run 20 s late", async () => {
    const t = await lateBy(20 * SEC);
    expect(t.runs).toEqual(["2026-10-12T05:00:00.000Z"]);
    expect(t.skipped()).toEqual([]);
  });

  it("still runs a run exactly one minute late, and skips one later than that", async () => {
    expect((await lateBy(MIN)).runs).toEqual(["2026-10-12T05:00:00.000Z"]);
    const t = await lateBy(MIN + SEC);
    expect(t.runs).toEqual([]);
    expect(t.skipped()).toHaveLength(1);
  });
});
