import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import type { Clock } from "../../core/timer.js";
import { HaClient } from "./client.js";
import { createHistory, localMidnight, parseTime, type HistoryQueries } from "./history.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import type { HaState } from "./types.js";

/** Local time in Europe/Berlin on 2026-10-11 (UTC+2), e.g. `local("08:30")`. */
const local = (time: string, day = "2026-10-11"): Date => new Date(`${day}T${time}:00+02:00`);

const row = (entityId: string, state: string, at: Date, attributes = {}): HaState => ({
  entity_id: entityId,
  state,
  attributes,
  last_changed: at.toISOString(),
  last_updated: at.toISOString(),
  context: { id: "c", parent_id: null, user_id: null },
});

describe("history queries", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let h: HistoryQueries;
  let now = local("12:00").getTime();
  const clock: Clock = { now: () => now, setTimeout: () => () => {} };

  beforeAll(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    ha.setHistory("switch.pump", [
      row("switch.pump", "off", local("08:00")),
      row("switch.pump", "on", local("09:00")),
      row("switch.pump", "on", local("09:10"), { power: 12 }),
      row("switch.pump", "off", local("09:30")),
    ]);
    ha.setHistory("cover.bath", [
      row("cover.bath", "closed", local("22:00", "2026-10-10")),
      row("cover.bath", "open", local("07:00")),
    ]);
    ha.setHistory("person.dennis", [
      row("person.dennis", "home", local("07:10")),
      row("person.dennis", "not_home", local("08:00")),
      row("person.dennis", "home", local("17:45")),
    ]);
    ha.setHistory("person.guest", [row("person.guest", "home", local("18:00", "2026-10-10"))]);
    await ha.start();
    client = new HaClient(
      {
        baseUrl: ha.url,
        wsUrl: ha.wsUrl,
        restUrl: `${ha.url}/api`,
        token: TOKEN,
        supervisor: false,
      },
      logCapture([]).log,
    );
    await client.start();
    h = createHistory(client, clock);
  });

  afterAll(async () => {
    await client.stop();
    await ha.stop();
  });

  it("returns the state changes since a time, starting with the state in effect then", async () => {
    expect(await h.history("switch.pump", local("08:30"))).toEqual([
      { state: "off", at: local("08:30") },
      { state: "on", at: local("09:00") },
      { state: "off", at: local("09:30") },
    ]);
    expect(ha.received.at(-1)).toMatchObject({
      type: "history/history_during_period",
      entity_ids: ["switch.pump"],
      start_time: local("08:30").toISOString(),
      end_time: local("12:00").toISOString(),
      include_start_time_state: true,
      minimal_response: true,
      no_attributes: true,
    });
  });

  it("limits the range with until", async () => {
    expect(await h.history("switch.pump", local("08:30"), local("09:15"))).toEqual([
      { state: "off", at: local("08:30") },
      { state: "on", at: local("09:00") },
    ]);
  });

  it("returns the historic state at a point in time", async () => {
    expect(await h.stateAt("cover.bath", local("03:00"))).toBe("closed");
    expect(await h.stateAt("cover.bath", local("10:00"))).toBe("open");
    expect(await h.stateAt("cover.bath", local("12:00", "2026-10-01"))).toBeUndefined();
  });

  it("returns the last time an entity changed to a value today", async () => {
    now = local("20:00").getTime();
    expect(await h.lastChangedTo("person.dennis", "home")).toEqual(local("17:45"));
    expect(await h.lastChangedTo("person.dennis", "home", local("06:00"))).toEqual(local("17:45"));
    expect(await h.lastChangedTo("person.dennis", "not_home", "13h")).toEqual(local("08:00"));
    expect(await h.lastChangedTo("person.dennis", "away")).toBeUndefined();
    // Home since yesterday: no change to "home" happened today.
    expect(await h.lastChangedTo("person.guest", "home")).toBeUndefined();
    now = local("12:00").getTime();
  });

  it("accepts durations and ISO strings as times", async () => {
    await h.history("switch.pump", "24h");
    expect(ha.received.at(-1)).toMatchObject({
      start_time: local("12:00", "2026-10-10").toISOString(),
    });
    await h.history("switch.pump", "2026-10-11T08:30:00+02:00");
    expect(ha.received.at(-1)).toMatchObject({ start_time: local("08:30").toISOString() });
  });

  it("rejects malformed times, numbers and entity IDs at the call site", () => {
    expect(() => parseTime("5 minutes", now, "history")).toThrow(/invalid time "5 minutes"/);
    expect(() => parseTime(3_600_000, now, "history")).toThrow(/use a Date/);
    expect(() => parseTime(new Date("nope"), now, "history")).toThrow(TypeError);
    expect(() => h.history("pump", "1h")).toThrow(/not an entity ID/);
    expect(() => h.history("switch.pump", local("10:00"), local("09:00"))).toThrow(
      /end lies before the start/,
    );
  });

  it("finds local midnight in Home Assistant's time zone, also on DST days", () => {
    expect(localMidnight(local("12:00").getTime(), "Europe/Berlin")).toBe(local("00:00").getTime());
    expect(localMidnight(local("00:00").getTime(), "Europe/Berlin")).toBe(local("00:00").getTime());
    // 2026-10-25: clocks go back at 03:00 CEST; midnight was still at UTC+2.
    expect(localMidnight(Date.parse("2026-10-25T12:00:00Z"), "Europe/Berlin")).toBe(
      Date.parse("2026-10-24T22:00:00Z"),
    );
    expect(localMidnight(Date.parse("2026-03-29T12:00:00Z"), "Europe/Berlin")).toBe(
      Date.parse("2026-03-28T23:00:00Z"),
    );
  });
});
