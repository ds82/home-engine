import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { logCapture, TOKEN, type LogCapture } from "../../core/testing/log-capture.js";
import type { Clock } from "../../core/timer.js";
import { HaClient } from "./client.js";
import { createHistory, meterChange, type HistoryQueries } from "./history.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import type { HaState } from "./types.js";

/** Local time in Europe/Berlin on 2026-10-11 (UTC+2). */
const local = (time: string): number => Date.parse(`2026-10-11T${time}:00+02:00`);

const reading = (entityId: string, state: string, at: number, attributes = {}): HaState => ({
  entity_id: entityId,
  state,
  attributes,
  last_changed: new Date(at).toISOString(),
  last_updated: new Date(at).toISOString(),
  context: { id: "c", parent_id: null, user_id: null },
});

// ha-history: Change of cumulative sensors, computed from recorded states.
describe("changeSince", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let capture: LogCapture;
  let h: HistoryQueries;
  let now = local("15:00");
  const clock: Clock = { now: () => now, setTimeout: () => () => {} };

  const meter = (entityId: string, values: Array<[string, string, object?]>): void => {
    ha.setHistory(
      entityId,
      values.map(([time, state, attributes]) => reading(entityId, state, local(time), attributes)),
    );
  };

  beforeAll(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    meter("sensor.house_energy", [
      ["11:00", "1190.0"],
      ["12:20", "1200.0"],
      ["13:10", "1201.5"],
      ["14:40", "1203.0"],
    ]);
    meter("sensor.short", [
      ["14:45", "1200.0"],
      ["14:58", "1200.4"],
    ]);
    meter("sensor.reset", [
      ["12:00", "50.0"],
      ["13:00", "52.0"],
      ["13:30", "0.0"],
      ["14:00", "1.5"],
    ]);
    meter("sensor.dip", [
      ["12:00", "1000.0"],
      ["13:00", "999.9"],
      ["14:00", "unavailable"],
      ["14:30", "1000.2"],
    ]);
    const cycle = (day: string) => ({ state_class: "total", last_reset: `2026-10-${day}T00:00Z` });
    meter("sensor.gas", [
      ["12:00", "10.0", cycle("10")],
      ["13:00", "15.0", cycle("10")],
      ["13:30", "3.0", cycle("11")],
      ["14:00", "4.0", cycle("11")],
    ]);
    ha.setState("sensor.gas", "4.0", { state_class: "total", last_reset: "2026-10-11T00:00Z" });
    // History only from 14:00 on; hourly statistics before.
    meter("sensor.old", [["14:00", "300.0"]]);
    ha.setStatistics("sensor.old", [
      { start: local("11:00"), end: local("12:00"), change: 2 },
      { start: local("12:00"), end: local("13:00"), change: 3 },
    ]);
    await ha.start();
    capture = logCapture([]);
    client = new HaClient(
      {
        baseUrl: ha.url,
        wsUrl: ha.wsUrl,
        restUrl: `${ha.url}/api`,
        token: TOKEN,
        supervisor: false,
      },
      capture.log,
    );
    await client.start();
    h = createHistory(client, clock, capture.log);
  });

  beforeEach(() => {
    now = local("15:00");
  });

  afterAll(async () => {
    await client.stop();
    await ha.stop();
  });

  it("covers a range starting within an hour, including the part before the full hour", async () => {
    expect(await h.changeSince("sensor.house_energy", new Date(local("12:34")))).toBeCloseTo(3.0);
  });

  it("covers a range shorter than an hour without a warning", async () => {
    expect(await h.changeSince("sensor.short", "10m")).toBeCloseTo(0.4);
    expect(capture.entries().filter((e) => e.level === "warn")).toEqual([]);
  });

  it("counts a meter reset within the range like Home Assistant", async () => {
    expect(await h.changeSince("sensor.reset", new Date(local("12:00")))).toBeCloseTo(3.5);
  });

  it("does not take a small dip for a reset", async () => {
    expect(await h.changeSince("sensor.dip", new Date(local("12:00")))).toBeCloseTo(0.2);
  });

  it("starts a new cycle of a total sensor when last_reset changes", async () => {
    expect(await h.changeSince("sensor.gas", new Date(local("12:00")))).toBeCloseTo(9.0);
    expect(ha.received.at(-1)).toMatchObject({
      type: "history/history_during_period",
      minimal_response: false,
      no_attributes: false,
    });
  });

  it("uses hourly statistics for a range older than the recorded history", async () => {
    now = local("13:00");
    expect(
      await h.changeSince("sensor.old", new Date(local("11:00")), new Date(local("13:00"))),
    ).toBeCloseTo(5);
    expect(ha.received.at(-1)).toMatchObject({ type: "recorder/statistics_during_period" });
  });
});

describe("meterChange", () => {
  const values = (...v: number[]) => v.map((value) => ({ value }));

  it("adds the net change of each cycle", () => {
    expect(meterChange(values(1000, 999.9, 1000.2), "total_increasing")).toBeCloseTo(0.2);
    expect(meterChange(values(100, 89.9, 95), "total_increasing")).toBeCloseTo(95);
    expect(meterChange(values(100, 90, 95), "total_increasing")).toBeCloseTo(-5);
    expect(meterChange(values(5, -1, 6), "total_increasing")).toBeCloseTo(1);
    expect(meterChange(values(10, 4), "total")).toBeCloseTo(-6);
    expect(meterChange([], "total_increasing")).toBeUndefined();
  });
});
