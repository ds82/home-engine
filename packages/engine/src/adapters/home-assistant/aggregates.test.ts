import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import type { Clock } from "../../core/timer.js";
import { HaClient } from "./client.js";
import { aggregate, createHistory, numericState, type HistoryQueries } from "./history.js";
import { MockHomeAssistant, type StatisticRow } from "./testing/mock-server.js";
import type { HaState } from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-11T10:00:00Z");

const row = (entityId: string, state: string, at: number): HaState => ({
  entity_id: entityId,
  state,
  attributes: {},
  last_changed: new Date(at).toISOString(),
  last_updated: new Date(at).toISOString(),
  context: { id: "c", parent_id: null, user_id: null },
});

describe("numeric aggregates", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let h: HistoryQueries;
  const clock: Clock = { now: () => NOW, setTimeout: () => () => {} };

  beforeAll(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    // 10 for three hours, then 20 for the last hour of a 4-hour range.
    ha.setHistory("sensor.temperature", [
      row("sensor.temperature", "10", NOW - 5 * HOUR),
      row("sensor.temperature", "20", NOW - HOUR),
    ]);
    ha.setHistory("sensor.dead", [row("sensor.dead", "unavailable", NOW - DAY)]);
    // 10 for two hours, unavailable for one, 20 for one: the gap does not count.
    ha.setHistory("sensor.flaky", [
      row("sensor.flaky", "10", NOW - 4 * HOUR),
      row("sensor.flaky", "unavailable", NOW - 2 * HOUR),
      row("sensor.flaky", "20", NOW - HOUR),
    ]);
    // The recorder kept 10 days (constantly 20); long-term statistics go back further.
    ha.setHistory("sensor.outdoor", [row("sensor.outdoor", "20", NOW - 10 * DAY)]);
    const stats: StatisticRow[] = [];
    for (let t = NOW - 40 * DAY; t < NOW - 10 * DAY; t += HOUR) {
      stats.push({ start: t, end: t + HOUR, mean: 10, min: 8, max: 25 });
    }
    ha.setStatistics("sensor.outdoor", stats);
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

  it("weights the average by time: 10 for 3 h and 20 for 1 h is 12.5", async () => {
    expect(await h.averageSince("sensor.temperature", "4h")).toBe(12.5);
    expect(await h.minimumSince("sensor.temperature", "4h")).toBe(10);
    expect(await h.maximumSince("sensor.temperature", "4h")).toBe(20);
    expect(await h.averageSince("sensor.temperature", "4h", "2h")).toBe(10);
  });

  it("leaves out non-numeric states", async () => {
    expect(await h.averageSince("sensor.flaky", "4h")).toBeCloseTo(40 / 3);
    expect(await h.minimumSince("sensor.flaky", "4h")).toBe(10);
  });

  it("returns undefined when the sensor was unavailable during the whole range", async () => {
    expect(await h.averageSince("sensor.dead", "4h")).toBeUndefined();
    expect(await h.minimumSince("sensor.dead", "4h")).toBeUndefined();
    expect(await h.maximumSince("sensor.dead", "4h")).toBeUndefined();
  });

  it("fills the part older than the recorder's history from long-term statistics", async () => {
    // 20 days of hourly means of 10, then 10 days of history at 20.
    expect(await h.averageSince("sensor.outdoor", "30d")).toBeCloseTo((20 * 10 + 10 * 20) / 30);
    expect(await h.minimumSince("sensor.outdoor", "30d")).toBe(8);
    expect(await h.maximumSince("sensor.outdoor", "30d")).toBe(25);
    expect(ha.received.at(-1)).toMatchObject({
      type: "recorder/statistics_during_period",
      statistic_ids: ["sensor.outdoor"],
      period: "hour",
      types: ["mean", "min", "max"],
    });
    // Within the retained history no statistics are needed.
    const before = ha.received.length;
    expect(await h.averageSince("sensor.outdoor", "5d")).toBe(20);
    expect(ha.received.slice(before).map((m) => m.type)).toEqual(["history/history_during_period"]);
  });

  it("clips partial statistics hours and parses numeric states strictly", () => {
    expect(
      aggregate([
        { from: 0, to: 30, mean: 10, min: 5, max: 15 },
        { from: 30, to: 30, mean: 1000, min: 1000, max: 1000 },
        { from: 30, to: 60, mean: 20, min: 20, max: 20 },
      ]),
    ).toEqual({ average: 15, minimum: 5, maximum: 20 });
    expect(numericState("21.5")).toBe(21.5);
    expect(numericState("unavailable")).toBeUndefined();
    expect(numericState("")).toBeUndefined();
  });
});
