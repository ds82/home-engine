import type { RuleEvent, SunEvent, Trigger } from "@home-engine/sdk";
import { getTimes } from "suncalc";
import { describe, expect, it } from "vitest";
import type { RuleDefinition } from "./registration.js";
import { startRule } from "./rule-runner.js";
import { createScheduling } from "./scheduling.js";
import { nextSunEvent, parseOffset, type Location } from "./sun.js";
import { FakeClock } from "./testing/fake-clock.js";
import { logCapture, type LogCapture } from "./testing/log-capture.js";
import { sun } from "./trigger-constructors.js";

const HOUR = 3_600_000;
const BERLIN: Location = { latitude: 52.52, longitude: 13.405, elevation: 34 };
const LONGYEARBYEN: Location = { latitude: 78.22, longitude: 15.65, elevation: 0 };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function scheduling(startIso: string, location: Location | undefined, timeZone = "Europe/Berlin") {
  const clock = new FakeClock(Date.parse(startIso));
  let loc = location;
  const listeners = new Set<() => void>();
  const capture: LogCapture = logCapture([]);
  capture.log.level = "debug";
  const s = createScheduling({
    clock,
    timeZone: () => timeZone,
    location: () => loc,
    onSiteChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    log: capture.log,
  });
  const moveTo = (next: Location): void => {
    loc = next;
    for (const l of listeners) l();
  };
  return { clock, s, capture, moveTo };
}

async function arm(env: ReturnType<typeof scheduling>, trigger: Trigger): Promise<SunEvent[]> {
  const events: SunEvent[] = [];
  const definition: RuleDefinition = {
    kind: "triggered",
    id: "test#sun",
    name: "sun",
    file: "test.ts",
    triggers: trigger,
    body: (e: RuleEvent) => void (e.type === "sun" && events.push(e)),
    options: {},
  };
  await startRule(definition, { sources: env.s.sources, log: logCapture([]).log });
  return events;
}

async function advanceHours(env: ReturnType<typeof scheduling>, hours: number): Promise<void> {
  for (let i = 0; i < hours; i++) {
    env.clock.advance(HOUR);
    await tick();
  }
}

const sunset = (iso: string, loc: Location): number =>
  getTimes(new Date(iso), loc.latitude, loc.longitude, loc.elevation).sunset?.getTime() ?? NaN;

describe("sun trigger", () => {
  it("fires every day 30 minutes before the local sunset", async () => {
    const env = scheduling("2026-06-21T06:00:00.000Z", BERLIN);
    const events = await arm(env, sun("sunset", { offset: "-30m" }));
    await advanceHours(env, 48);
    expect(events.map((e) => e.scheduledAt.getTime())).toEqual([
      sunset("2026-06-21T10:00:00Z", BERLIN) - 30 * 60_000,
      sunset("2026-06-22T10:00:00Z", BERLIN) - 30 * 60_000,
    ]);
    expect(events[0]).toMatchObject({ type: "sun", event: "sunset" });
  });

  it("does not fire on a day without sunset and logs it at debug level", async () => {
    const env = scheduling("2026-06-21T06:00:00.000Z", LONGYEARBYEN, "Arctic/Longyearbyen");
    const events = await arm(env, sun("sunset"));
    await advanceHours(env, 48);
    expect(events).toEqual([]);
    expect(env.capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "debug",
        message: expect.stringMatching(/No sunset on this day/),
      }),
    );
  });

  it("waits for the location and recomputes when the Site changes", async () => {
    const env = scheduling("2026-06-21T06:00:00.000Z", undefined);
    const events = await arm(env, sun("sunset"));
    await advanceHours(env, 2);
    env.moveTo(BERLIN);
    await advanceHours(env, 16);
    expect(events.map((e) => e.scheduledAt.getTime())).toEqual([
      sunset("2026-06-21T10:00:00Z", BERLIN),
    ]);

    env.moveTo(LONGYEARBYEN);
    await advanceHours(env, 24);
    expect(events).toHaveLength(1);
  });

  it("validates its arguments", () => {
    expect(() => sun("noon")).toThrow(/must be one of sunrise, sunset, dawn, dusk/);
    expect(() => sun("sunset", { offset: "-30 minutes" })).toThrow(/Invalid sun offset/);
    expect(() => sun("sunset", { shift: "1h" })).toThrow(/unknown option "shift"/);
    expect(sun("dawn", { offset: "+15m" })).toEqual({ kind: "sun", event: "dawn", offset: "+15m" });
    expect(parseOffset("-1h30m")).toBe(-5_400_000);
    expect(parseOffset(1000)).toBe(1000);
  });
});

describe("sun helpers", () => {
  it("knows that the sun is down at 23:00 in Berlin", () => {
    const night = scheduling("2026-06-21T21:00:00.000Z", BERLIN).s.sun;
    expect(night.isSunUp()).toBe(false);
    expect(night.isAfterSunset()).toBe(true);
    expect(night.isBeforeSunrise()).toBe(false);
  });

  it("knows that the sun is up at noon and before sunrise early in the morning", () => {
    expect(scheduling("2026-06-21T10:00:00.000Z", BERLIN).s.sun.isSunUp()).toBe(true);
    const early = scheduling("2026-06-21T00:30:00.000Z", BERLIN).s.sun;
    expect(early.isBeforeSunrise()).toBe(true);
    expect(early.isAfterSunset()).toBe(false);
  });

  it("returns the next sunrise", () => {
    const env = scheduling("2026-06-21T21:00:00.000Z", BERLIN);
    const next = env.s.sun.nextSun("sunrise");
    expect(next?.toISOString().slice(0, 10)).toBe("2026-06-22");
    expect(next?.getTime()).toBeGreaterThan(env.clock.now());
  });

  it("handles polar day and polar night", () => {
    const polarDay = scheduling("2026-06-21T22:00:00.000Z", LONGYEARBYEN, "Arctic/Longyearbyen").s
      .sun;
    expect(polarDay.isSunUp()).toBe(true);
    expect(polarDay.isAfterSunset()).toBe(false);
    const polarNight = scheduling("2026-12-21T12:00:00.000Z", LONGYEARBYEN, "Arctic/Longyearbyen").s
      .sun;
    expect(polarNight.isSunUp()).toBe(false);
    expect(polarNight.isBeforeSunrise()).toBe(true);
    expect(
      nextSunEvent(
        "sunrise",
        Date.parse("2026-12-21T12:00:00Z"),
        LONGYEARBYEN,
        "Arctic/Longyearbyen",
      ),
    ).toBeGreaterThan(Date.parse("2027-02-01T00:00:00Z"));
  });

  it("explains when the location is not known yet", () => {
    expect(() => scheduling("2026-06-21T10:00:00.000Z", undefined).s.sun.isSunUp()).toThrow(
      /needs the location from Home Assistant/,
    );
  });
});
