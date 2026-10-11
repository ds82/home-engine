import type { RuleEvent, TimeEvent, Trigger } from "@home-engine/sdk";
import { describe, expect, it } from "vitest";
import { evaluateFile, FileEvaluationError } from "./registration.js";
import type { RuleDefinition } from "./registration.js";
import { startRule } from "./rule-runner.js";
import { createScheduling, nextDaily } from "./scheduling.js";
import { FakeClock } from "./testing/fake-clock.js";
import { logCapture } from "./testing/log-capture.js";
import { cron, daily } from "./trigger-constructors.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function run(trigger: Trigger, startIso: string, days: number, timeZone = "Europe/Berlin") {
  const clock = new FakeClock(Date.parse(startIso));
  let tz = timeZone;
  const siteListeners = new Set<() => void>();
  const scheduling = createScheduling({
    clock,
    timeZone: () => tz,
    onSiteChange: (l) => {
      siteListeners.add(l);
      return () => siteListeners.delete(l);
    },
  });
  const events: TimeEvent[] = [];
  const definition: RuleDefinition = {
    kind: "triggered",
    id: "test#calendar",
    name: "calendar",
    file: "test.ts",
    triggers: trigger,
    body: (e: RuleEvent) => void (e.type === "time" && events.push(e)),
    options: {},
  };
  const rule = await startRule(definition, {
    sources: scheduling.sources,
    log: logCapture([]).log,
  });
  for (let i = 0; i < days * 24; i++) {
    clock.advance(HOUR);
    await tick();
  }
  const changeTimeZone = (next: string): void => {
    tz = next;
    for (const l of siteListeners) l();
  };
  return {
    events,
    times: () => events.map((e) => e.scheduledAt.toISOString()),
    clock,
    rule,
    changeTimeZone,
  };
}

describe("daily", () => {
  it("runs at the local time on the listed weekdays only", async () => {
    // Friday 9 Oct 2026, 05:00 Berlin; one week.
    const { times } = await run(
      daily("06:30", { weekdays: ["mon", "tue", "wed", "thu", "fri"] }),
      "2026-10-09T03:00:00.000Z",
      7,
    );
    expect(times()).toEqual([
      "2026-10-09T04:30:00.000Z",
      "2026-10-12T04:30:00.000Z",
      "2026-10-13T04:30:00.000Z",
      "2026-10-14T04:30:00.000Z",
      "2026-10-15T04:30:00.000Z",
    ]);
  });

  it("runs once at the end of the gap when the time does not exist (spring-forward)", async () => {
    // Berlin skips 02:00–03:00 on 29 March 2026.
    const { times } = await run(daily("02:30"), "2026-03-28T12:00:00.000Z", 3);
    expect(times()).toEqual([
      "2026-03-29T01:00:00.000Z", // 03:00 CEST, the first valid instant after the gap
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ]);
  });

  it("runs only once when the time occurs twice (fall-back)", async () => {
    // Berlin repeats 02:00–03:00 on 25 October 2026.
    const { times } = await run(daily("02:30"), "2026-10-24T12:00:00.000Z", 3);
    expect(times()).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
      "2026-10-27T01:30:00.000Z",
    ]);
  });

  it("uses Home Assistant's time zone, not the container's", async () => {
    const berlin = await run(daily("07:00"), "2026-10-11T00:00:00.000Z", 1, "Europe/Berlin");
    const utc = await run(daily("07:00"), "2026-10-11T00:00:00.000Z", 1, "UTC");
    expect(berlin.times()).toEqual(["2026-10-11T05:00:00.000Z"]);
    expect(utc.times()).toEqual(["2026-10-11T07:00:00.000Z"]);
  });

  it("does not replay a run missed while the engine was down", async () => {
    // Started at 07:05 Berlin: 07:00 today has passed and is not run.
    const { times } = await run(daily("07:00"), "2026-10-11T05:05:00.000Z", 1);
    expect(times()).toEqual(["2026-10-12T05:00:00.000Z"]);
  });

  it("recomputes the pending run when the Site's time zone changes", async () => {
    const result = await run(daily("07:00"), "2026-10-11T00:00:00.000Z", 0);
    result.changeTimeZone("UTC");
    for (let i = 0; i < 24; i++) {
      result.clock.advance(HOUR);
      await tick();
    }
    expect(result.times()).toEqual(["2026-10-11T07:00:00.000Z"]);
  });

  it("validates its arguments", () => {
    expect(() => daily("7:00")).toThrow(/not a time/);
    expect(() => daily("24:00")).toThrow(/not a time/);
    expect(() => daily("07:00", { weekdays: [] })).toThrow(/weekdays/);
    expect(() => daily("07:00", { weekdays: ["monday"] })).toThrow(/weekdays/);
    expect(() => daily("07:00", { days: ["mon"] })).toThrow(/unknown option "days"/);
    expect(daily("07:00:30", { weekdays: ["sat", "sat"] })).toEqual({
      kind: "daily",
      time: "07:00:30",
      weekdays: ["sat"],
    });
  });

  it("nextDaily never returns a time at or before the given instant", () => {
    const after = Date.parse("2026-03-29T01:00:00.000Z");
    expect(nextDaily("02:30", undefined, "Europe/Berlin", after)).toBeGreaterThan(after);
  });
});

describe("cron", () => {
  it("runs at minute 0 of every second hour in the Site's time zone", async () => {
    const { times } = await run(cron("0 */2 * * *"), "2026-10-11T00:30:00.000Z", 0.25);
    // Berlin is UTC+2: local 04:00, 06:00 and 08:00 within the six hours.
    expect(times()).toEqual([
      "2026-10-11T02:00:00.000Z",
      "2026-10-11T04:00:00.000Z",
      "2026-10-11T06:00:00.000Z",
    ]);
  });

  it("accepts 6-field expressions with seconds", () => {
    expect(cron("30 0 7 * * *")).toEqual({ kind: "cron", expression: "30 0 7 * * *" });
  });

  it("throws for an invalid expression, naming the field, and fails the file that uses it", async () => {
    expect(() => cron("61 * * * *")).toThrow(/minute/);
    expect(() => cron("* * * * * * *")).toThrow(/7 fields/);
    const err = await evaluateFile("bad-cron.ts", async () => {
      cron("61 * * * *");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileEvaluationError);
    expect((err as Error).message).toMatch(/bad-cron\.ts.*minute: 61/);
  });
});

describe("daily DST at day granularity", () => {
  it("keeps runs one local day apart across the transition", () => {
    const a =
      nextDaily("12:00", undefined, "Europe/Berlin", Date.parse("2026-03-28T00:00:00Z")) ?? 0;
    const b = nextDaily("12:00", undefined, "Europe/Berlin", a) ?? 0;
    expect(b - a).toBe(DAY - HOUR);
  });
});
