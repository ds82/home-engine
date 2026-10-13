import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuleScopeImpl } from "../../core/rule-scope.js";
import { invoke } from "../../core/run-context.js";
import { logCapture, TOKEN, type LogCapture } from "../../core/testing/log-capture.js";
import type { Clock } from "../../core/timer.js";
import { HaClient } from "./client.js";
import { createHistory, RecorderMissingError, type HistoryQueries } from "./history.js";
import { MockHomeAssistant, type StatisticRow } from "./testing/mock-server.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 12:30 in Europe/Berlin; local midnight was 2026-10-10T22:00Z. */
const NOW = Date.parse("2026-10-11T10:30:00Z");
const MIDNIGHT = Date.parse("2026-10-10T22:00:00Z");

describe("statistics, changeSince and recorder errors", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let capture: LogCapture;
  let h: HistoryQueries;
  const clock: Clock = { now: () => NOW, setTimeout: () => () => {} };

  beforeAll(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    const daily: StatisticRow[] = [];
    for (let t = MIDNIGHT - 40 * DAY; t < MIDNIGHT; t += DAY) {
      daily.push({ start: t, end: t + DAY, mean: 15, min: 9, max: 21 });
    }
    ha.setStatistics("sensor.temperature", daily);
    // The meter read 1200.0 at midnight and rose 1.0 every hour; it reads 1213.5 now.
    const hourly: StatisticRow[] = [];
    for (let i = 0; i < 12; i++) {
      const start = MIDNIGHT + i * HOUR;
      hourly.push({ start, end: start + HOUR, change: 1, state: 1201 + i, sum: 1 + i });
    }
    ha.setStatistics("sensor.house_energy", hourly);
    ha.setState("sensor.house_energy", "1213.5");
    ha.setState("sensor.noisy", "42");
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

  afterAll(async () => {
    await client.stop();
    await ha.stop();
  });

  it("returns daily mean statistics over the last 30 days", async () => {
    const days = await h.statistics("sensor.temperature", {
      since: "30d",
      period: "day",
      types: ["mean"],
    });
    expect(days.length).toBeGreaterThan(0);
    expect(days.length).toBeLessThanOrEqual(30);
    expect(days[0]).toEqual({ start: expect.any(Date), end: expect.any(Date), mean: 15 });
    expect(ha.received.at(-1)).toMatchObject({
      type: "recorder/statistics_during_period",
      statistic_ids: ["sensor.temperature"],
      period: "day",
      types: ["mean"],
      start_time: new Date(NOW - 30 * DAY).toISOString(),
    });
  });

  it("validates statistic IDs, periods and types", () => {
    expect(() => h.statistics("temperature", { since: "1d" })).toThrow(/not a statistic ID/);
    expect(() =>
      h.statistics("sensor.temperature", { since: "1d", period: "year" as never }),
    ).toThrow(/period "year"/);
    expect(() =>
      h.statistics("sensor.temperature", { since: "1d", types: ["avg" as never] }),
    ).toThrow(/not "avg"/);
  });

  it("returns the energy consumed since midnight, including the current hour", async () => {
    expect(await h.changeSince("sensor.house_energy", new Date(MIDNIGHT))).toBeCloseTo(13.5);
    // A closed range uses the compiled hours only.
    expect(
      await h.changeSince("sensor.house_energy", new Date(MIDNIGHT), new Date(MIDNIGHT + 3 * HOUR)),
    ).toBe(3);
  });

  it("counts the whole live reading after a meter reset in the current hour", async () => {
    ha.setState("sensor.house_energy", "0.5");
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
    expect(await h.changeSince("sensor.house_energy", new Date(MIDNIGHT))).toBeCloseTo(12.5);
  });

  it("returns undefined without statistics", async () => {
    expect(await h.changeSince("sensor.noisy", new Date(MIDNIGHT))).toBeUndefined();
  });

  it("warns once per entity and rule about entities without recorded history", async () => {
    const run = async (ruleId: string): Promise<unknown> => {
      const scope = new RuleScopeImpl(ruleId, capture.log);
      let result: unknown;
      await invoke(scope, "body", async () => {
        result = await h.history("sensor.noisy", "1h");
        await h.history("sensor.noisy", "2h");
      }).done;
      await scope.dispose();
      return result;
    };
    expect(await run("a#one")).toEqual([]);
    await run("a#one");
    await run("b#two");
    const warnings = capture
      .entries()
      .filter(
        (e) =>
          e.level === "warn" && String(e.message).includes("sensor.noisy has no recorded history"),
      );
    expect(warnings.map((w) => w.source)).toEqual(["a#one", "b#two"]);
  });

  it("does not warn when a query lies before a recorded entity's first record", async () => {
    ha.setHistory("sensor.new", [
      {
        entity_id: "sensor.new",
        state: "5",
        attributes: {},
        last_changed: new Date(MIDNIGHT + HOUR).toISOString(),
        last_updated: new Date(MIDNIGHT + HOUR).toISOString(),
        context: { id: "c", parent_id: null, user_id: null },
      },
    ]);
    expect(await h.stateAt("sensor.new", new Date(MIDNIGHT - DAY))).toBeUndefined();
    expect(
      capture
        .entries()
        .filter((e) => e.level === "warn" && String(e.message).includes("sensor.new")),
    ).toEqual([]);
  });

  it("rejects with a clear error when Home Assistant has no recorder", async () => {
    for (const type of ["history/history_during_period", "recorder/statistics_during_period"]) {
      ha.onCommand(type, () => ({
        error: { code: "unknown_command", message: `Unknown command: ${type}` },
      }));
    }
    await expect(h.history("sensor.noisy", "1h")).rejects.toBeInstanceOf(RecorderMissingError);
    await expect(h.averageSince("sensor.noisy", "1h")).rejects.toThrow(/recorder integration/);
    await expect(h.statistics("sensor.temperature", { since: "1d" })).rejects.toThrow(
      /recorder integration/,
    );
  });
});
