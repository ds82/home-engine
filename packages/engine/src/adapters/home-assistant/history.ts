// History queries (ha-history; design D15) on Home Assistant's recorder:
// `history/history_during_period` for `history`, `stateAt`, `lastChangedTo` and the
// aggregates, `recorder/statistics_during_period` for `statistics` and `changeSince`.
// Points in time are a Date, an ISO 8601 string, or a duration meaning "that long ago".

import { parseDuration } from "../../core/duration.js";
import { nextLocalTime } from "../../core/scheduling.js";
import type { Logger } from "../../core/logger.js";
import { currentRun } from "../../core/run-context.js";
import type { Clock } from "../../core/timer.js";
import { realClock } from "../../core/timer.js";
import type { HaClient } from "./client.js";
import { HaCommandError } from "./session.js";
import { NotConnectedError } from "./writes.js";

/** A recorded state and the time it took effect. */
export interface HistoryEntry {
  state: string;
  at: Date;
}

export type TimeArg = Date | string;

export interface HistoryQueries {
  history(entity: string, since: TimeArg, until?: TimeArg): Promise<HistoryEntry[]>;
  stateAt(entity: string, time: TimeArg): Promise<string | undefined>;
  lastChangedTo(
    entity: string,
    value: string | number | boolean,
    since?: TimeArg,
  ): Promise<Date | undefined>;
  averageSince(entity: string, since: TimeArg, until?: TimeArg): Promise<number | undefined>;
  minimumSince(entity: string, since: TimeArg, until?: TimeArg): Promise<number | undefined>;
  maximumSince(entity: string, since: TimeArg, until?: TimeArg): Promise<number | undefined>;
  changeSince(entity: string, since: TimeArg, until?: TimeArg): Promise<number | undefined>;
  statistics(statisticId: string, options: StatisticsOptions): Promise<StatisticsEntry[]>;
}

export const STATISTIC_PERIODS = ["5minute", "hour", "day", "week", "month"] as const;
export const STATISTIC_TYPES = ["mean", "min", "max", "sum", "state", "change"] as const;
export type StatisticPeriod = (typeof STATISTIC_PERIODS)[number];
export type StatisticType = (typeof STATISTIC_TYPES)[number];

export interface StatisticsOptions {
  since: TimeArg;
  until?: TimeArg;
  /** Default `hour`. */
  period?: StatisticPeriod;
  /** Default `mean`, `min` and `max`. */
  types?: readonly StatisticType[];
}

/** One period of long-term statistics; only the requested types are present. */
export interface StatisticsEntry {
  start: Date;
  end: Date;
  mean?: number;
  min?: number;
  max?: number;
  sum?: number;
  state?: number;
  change?: number;
}

/** Home Assistant has no recorder, so there is no history to query. */
export class RecorderMissingError extends Error {
  constructor(what: string) {
    super(
      `${what}: history needs Home Assistant's recorder integration, which is not loaded ` +
        `(add "recorder:" or "default_config:" to configuration.yaml)`,
    );
    this.name = "RecorderMissingError";
  }
}

/**
 * A stretch of time with known numeric values: a single state from history, or an hourly
 * long-term statistics row (mean, min and max over the stretch).
 */
export interface Segment {
  from: number;
  to: number;
  mean: number;
  min: number;
  max: number;
}

export interface Aggregates {
  average: number | undefined;
  minimum: number | undefined;
  maximum: number | undefined;
}

/** Time-weighted average, minimum and maximum; undefined when no segment has a duration. */
export function aggregate(segments: readonly Segment[]): Aggregates {
  let weighted = 0;
  let duration = 0;
  let minimum: number | undefined;
  let maximum: number | undefined;
  for (const seg of segments) {
    const ms = seg.to - seg.from;
    if (ms <= 0) {
      continue;
    }
    weighted += seg.mean * ms;
    duration += ms;
    minimum = minimum === undefined ? seg.min : Math.min(minimum, seg.min);
    maximum = maximum === undefined ? seg.max : Math.max(maximum, seg.max);
  }
  return { average: duration > 0 ? weighted / duration : undefined, minimum, maximum };
}

/** A state as a number, or undefined for `unknown`, `unavailable` and other text. */
export function numericState(state: string): number | undefined {
  if (state.trim() === "") {
    return undefined;
  }
  const value = Number(state);
  return Number.isFinite(value) ? value : undefined;
}

/** One row of `recorder/statistics_during_period` (times as epoch ms or ISO strings). */
interface StatisticsRow {
  start: number | string;
  end: number | string;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  state?: number | null;
  change?: number | null;
}

const epochMs = (t: number | string): number => (typeof t === "number" ? t : Date.parse(t));

/** A row of the compressed history format (`minimal_response`, `no_attributes`). */
interface CompressedRow {
  s: string;
  /** last_updated, epoch seconds. */
  lu: number;
  /** last_changed, epoch seconds; omitted when equal to lu. */
  lc?: number;
  /** Attributes, unless requested without. */
  a?: Record<string, unknown>;
}

/** A recorded value of a cumulative sensor, with `last_reset` for state class `total`. */
export interface MeterReading {
  value: number;
  lastReset?: unknown;
}

/**
 * How much a cumulative sensor rose over consecutive readings, the way Home Assistant's
 * statistics count it (sensor/recorder.py: reset_detected and compile_statistics). The
 * readings form cycles; each adds its last value minus its start, so a dip within a cycle
 * only counts through the net change. A `total_increasing` value below 90 % of the previous
 * one starts a new cycle, a changed `last_reset` does for `total`; a new cycle starts at 0.
 * Negative `total_increasing` values are skipped. Undefined without readings.
 */
export function meterChange(
  readings: readonly MeterReading[],
  stateClass: "total" | "total_increasing",
): number | undefined {
  let sum = 0;
  let cycleStart: number | undefined;
  let previous: number | undefined;
  let lastReset: unknown;
  for (const { value, lastReset: reset } of readings) {
    if (stateClass === "total_increasing" && value < 0) {
      continue;
    }
    if (previous === undefined || cycleStart === undefined) {
      cycleStart = value;
      previous = value;
      lastReset = reset;
      continue;
    }
    const isReset =
      stateClass === "total"
        ? reset !== undefined && reset !== null && reset !== lastReset
        : value < 0.9 * previous;
    if (isReset) {
      sum += previous - cycleStart;
      cycleStart = 0;
      lastReset = reset;
    }
    previous = value;
  }
  return previous === undefined || cycleStart === undefined
    ? undefined
    : sum + previous - cycleStart;
}

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function checkEntity(fn: string, entity: unknown): string {
  if (typeof entity !== "string" || !ENTITY_ID.test(entity)) {
    throw new TypeError(`${fn}(): ${JSON.stringify(entity)} is not an entity ID`);
  }
  return entity;
}

/**
 * Converts a time argument to epoch ms. Durations (`"24h"`, `"7d"`) count back from `now`.
 * Plain numbers are rejected: as milliseconds-ago and as epoch they would be easy to mix up.
 */
export function parseTime(value: unknown, now: number, fn: string, what = "time"): number {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) {
      return value.getTime();
    }
  } else if (typeof value === "string") {
    try {
      return now - parseDuration(value);
    } catch {
      // Not a duration: try ISO 8601.
    }
    const at = Date.parse(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(value.trim()) && !Number.isNaN(at)) {
      return at;
    }
  }
  throw new TypeError(
    `${fn}(): invalid ${what} ${JSON.stringify(value)}; use a Date, an ISO 8601 string such as ` +
      `"2026-10-11T08:00:00" or a duration such as "24h"`,
  );
}

/** Local midnight (in `timeZone`) at the start of the day containing `now`. */
export function localMidnight(now: number, timeZone: string | undefined): number {
  let midnight = nextLocalTime("00:00:00", timeZone, now - 26 * 3_600_000);
  for (;;) {
    const next = nextLocalTime("00:00:00", timeZone, midnight);
    if (next > now) {
      return midnight;
    }
    midnight = next;
  }
}

export function createHistory(
  client: HaClient,
  clock: Clock = realClock,
  log?: Logger,
): HistoryQueries {
  /** Sends a recorder command; a missing recorder becomes a RecorderMissingError. */
  async function recorder<T>(what: string, message: Record<string, unknown> & { type: string }) {
    const session = client.connection.current;
    if (!session || !client.isReady) {
      throw new NotConnectedError(what);
    }
    try {
      return await session.command<T>(message);
    } catch (err) {
      if (err instanceof HaCommandError && err.code === "unknown_command") {
        throw new RecorderMissingError(what);
      }
      throw err;
    }
  }

  // Entities without recorded data: warned about once per entity and rule.
  const warned = new Set<string>();
  const warnOnce = (entity: string, message: string): void => {
    const run = currentRun();
    const key = `${run?.scope.ruleId ?? "-"}\0${entity}`;
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    (run?.scope.log ?? log)?.warn({ entity }, message);
  };

  // Whether an entity is recorded at all, probed once per entity and rule (like the warning).
  const recorded = new Map<string, boolean>();
  /**
   * True when the recorder has any state of `entity`. An empty query can also mean the range
   * lies before the entity's first record; Home Assistant always returns the state in effect
   * at the start for a recorded entity, so the last minute shows whether it is recorded.
   */
  async function isRecorded(entity: string): Promise<boolean> {
    const key = `${currentRun()?.scope.ruleId ?? "-"}\0${entity}`;
    const known = recorded.get(key);
    if (known !== undefined) {
      return known;
    }
    const now = clock.now();
    const probe = await recorder<Record<string, CompressedRow[] | undefined>>(
      `history of ${entity}`,
      {
        type: "history/history_during_period",
        start_time: new Date(now - 60_000).toISOString(),
        end_time: new Date(now).toISOString(),
        entity_ids: [entity],
        include_start_time_state: true,
        significant_changes_only: false,
        minimal_response: true,
        no_attributes: true,
      },
    );
    const result = (probe[entity]?.length ?? 0) > 0;
    recorded.set(key, result);
    return result;
  }

  /**
   * State changes of `entity` in [start, end), oldest first. The first entry is the state in
   * effect at `start` (if recorded), dated `start`. Rows that repeat the previous state
   * (attribute-only updates) are dropped.
   */
  async function query(entity: string, start: number, end: number): Promise<HistoryEntry[]> {
    const result = await recorder<Record<string, CompressedRow[] | undefined>>(
      `history of ${entity}`,
      {
        type: "history/history_during_period",
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        entity_ids: [entity],
        include_start_time_state: true,
        significant_changes_only: false,
        minimal_response: true,
        no_attributes: true,
      },
    );
    if (!result[entity]?.length && !(await isRecorded(entity))) {
      warnOnce(
        entity,
        `${entity} has no recorded history; it is unknown or excluded from the recorder`,
      );
    }
    const entries: HistoryEntry[] = [];
    for (const row of result[entity] ?? []) {
      if (entries.at(-1)?.state === row.s) {
        continue;
      }
      const at = Math.max(start, Math.round((row.lc ?? row.lu) * 1000));
      entries.push({ state: row.s, at: new Date(at) });
    }
    return entries;
  }

  /**
   * changeSince from recorded states, or undefined when the recorder's history does not
   * reach back to `start` (or has no numeric state), so statistics must be used instead.
   */
  async function meterHistory(entity: string, start: number, end: number) {
    const stateClass =
      client.states.get(entity)?.attributes.state_class === "total" ? "total" : "total_increasing";
    // `total` needs last_reset on every row, which minimal responses leave out.
    const withAttributes = stateClass === "total";
    const result = await recorder<Record<string, CompressedRow[] | undefined>>(
      `history of ${entity}`,
      {
        type: "history/history_during_period",
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        entity_ids: [entity],
        include_start_time_state: true,
        significant_changes_only: false,
        minimal_response: !withAttributes,
        no_attributes: !withAttributes,
      },
    );
    const rows = result[entity] ?? [];
    const first = rows[0];
    if (!first || Math.round(first.lu * 1000) > start) {
      return undefined; // nothing in effect at `start`: older than the recorder keeps
    }
    const readings: MeterReading[] = [];
    for (const row of rows) {
      const value = numericState(row.s);
      if (value !== undefined) {
        readings.push({ value, lastReset: row.a?.last_reset });
      }
    }
    return meterChange(readings, stateClass);
  }

  /** Hourly long-term statistics clipped to [start, end), as segments. */
  async function statisticsSegments(
    entity: string,
    start: number,
    end: number,
  ): Promise<Segment[]> {
    // Hourly rows start on the hour: begin at the hour containing `start`.
    const from = Math.floor(start / 3_600_000) * 3_600_000;
    const rows = await statisticsRows(entity, from, end, "hour", ["mean", "min", "max"]);
    const segments: Segment[] = [];
    for (const row of rows) {
      const { mean, min, max } = row;
      if (typeof mean !== "number" || typeof min !== "number" || typeof max !== "number") {
        continue;
      }
      const segFrom = Math.max(start, epochMs(row.start));
      const segTo = Math.min(end, epochMs(row.end));
      if (segTo > segFrom) {
        segments.push({ from: segFrom, to: segTo, mean, min, max });
      }
    }
    return segments;
  }

  /**
   * Numeric segments over [start, end): states from history, and where history starts later
   * than `start` (older than the recorder keeps), hourly long-term statistics before it.
   */
  async function numericSegments(entity: string, start: number, end: number): Promise<Segment[]> {
    const entries = await query(entity, start, end);
    const segments: Segment[] = [];
    entries.forEach((entry, i) => {
      const value = numericState(entry.state);
      if (value === undefined) {
        return;
      }
      const next = entries[i + 1];
      const to = next ? next.at.getTime() : end;
      segments.push({ from: entry.at.getTime(), to, mean: value, min: value, max: value });
    });
    const covered = entries[0]?.at.getTime() ?? end;
    if (covered > start) {
      segments.unshift(...(await statisticsSegments(entity, start, covered)));
    }
    return segments;
  }

  function statisticsRows(
    statisticId: string,
    start: number,
    end: number,
    period: StatisticPeriod,
    types: readonly StatisticType[],
  ): Promise<StatisticsRow[]> {
    return recorder<Record<string, StatisticsRow[] | undefined>>(`statistics of ${statisticId}`, {
      type: "recorder/statistics_during_period",
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      statistic_ids: [statisticId],
      period,
      types: [...types],
    }).then((result) => result[statisticId] ?? []);
  }

  const aggregateFn =
    (fn: string, pick: keyof Aggregates) =>
    (entity: string, since: TimeArg, until?: TimeArg): Promise<number | undefined> => {
      checkEntity(fn, entity);
      const { start, end } = range(fn, since, until);
      return numericSegments(entity, start, end).then((segments) => aggregate(segments)[pick]);
    };

  const range = (fn: string, since: unknown, until: unknown): { start: number; end: number } => {
    const now = clock.now();
    const start = parseTime(since, now, fn, "start");
    const end = until === undefined ? now : parseTime(until, now, fn, "end");
    if (end < start) {
      throw new RangeError(`${fn}(): the end lies before the start`);
    }
    return { start, end };
  };

  return {
    statistics(statisticId, options) {
      if (typeof statisticId !== "string" || !/^[a-z0-9_]+[.:][a-z0-9_]+$/.test(statisticId)) {
        throw new TypeError(`statistics(): ${JSON.stringify(statisticId)} is not a statistic ID`);
      }
      if (typeof options !== "object" || options === null) {
        throw new TypeError(`statistics(): pass options such as { since: "30d", period: "day" }`);
      }
      const period = options.period ?? "hour";
      if (!STATISTIC_PERIODS.includes(period)) {
        throw new TypeError(
          `statistics(): period ${JSON.stringify(period)} is not one of ${STATISTIC_PERIODS.join(", ")}`,
        );
      }
      const types = options.types ?? ["mean", "min", "max"];
      const unknown = types.find((t) => !STATISTIC_TYPES.includes(t));
      if (unknown !== undefined || types.length === 0) {
        throw new TypeError(
          `statistics(): types must be some of ${STATISTIC_TYPES.join(", ")}` +
            (unknown === undefined ? "" : `, not ${JSON.stringify(unknown)}`),
        );
      }
      const { start, end } = range("statistics", options.since, options.until);
      return statisticsRows(statisticId, start, end, period, types).then((rows) => {
        if (rows.length === 0) {
          warnOnce(
            statisticId,
            `${statisticId} has no long-term statistics; it needs a state_class and must be recorded`,
          );
        }
        return rows.map((row) => {
          const entry: StatisticsEntry = {
            start: new Date(epochMs(row.start)),
            end: new Date(epochMs(row.end)),
          };
          for (const type of types) {
            const value = row[type];
            if (typeof value === "number") {
              entry[type] = value;
            }
          }
          return entry;
        });
      });
    },

    /**
     * The exact change over the range from recorded states while the recorder still keeps
     * them (meterChange). For older ranges, sums the hourly `change` statistics (which
     * account for meter resets) from the first full hour after `since`; when the range ends
     * now, the current, not yet compiled hour is added from the live state: its rise since
     * the last hourly reading, or the whole reading after a reset.
     */
    async changeSince(entity, since, until) {
      checkEntity("changeSince", entity);
      const { start, end } = range("changeSince", since, until);
      const fromHistory = await meterHistory(entity, start, end);
      if (fromHistory !== undefined) {
        return fromHistory;
      }
      const from = Math.ceil(start / 3_600_000) * 3_600_000;
      const rows =
        from < end ? await statisticsRows(entity, from, end, "hour", ["change", "state"]) : [];
      const withChange = rows.filter((r) => typeof r.change === "number");
      if (withChange.length === 0 && until !== undefined) {
        warnOnce(entity, `${entity} has no long-term statistics; changeSince needs a state_class`);
        return undefined;
      }
      let total = withChange.reduce((sum, r) => sum + (r.change as number), 0);
      if (until === undefined) {
        const last = rows.at(-1);
        const live = numericState(client.states.get(entity)?.state ?? "");
        const lastReading = typeof last?.state === "number" ? last.state : undefined;
        if (live === undefined || lastReading === undefined) {
          if (withChange.length === 0) {
            warnOnce(
              entity,
              `${entity} has no long-term statistics; changeSince needs a state_class`,
            );
            return undefined;
          }
          return total;
        }
        total += live >= lastReading ? live - lastReading : live;
      }
      return total;
    },

    averageSince: aggregateFn("averageSince", "average"),
    minimumSince: aggregateFn("minimumSince", "minimum"),
    maximumSince: aggregateFn("maximumSince", "maximum"),

    history(entity, since, until) {
      checkEntity("history", entity);
      const { start, end } = range("history", since, until);
      return query(entity, start, end);
    },

    async stateAt(entity, time) {
      checkEntity("stateAt", entity);
      const at = parseTime(time, clock.now(), "stateAt");
      const entries = await query(entity, at, at + 1);
      const first = entries[0];
      return first && first.at.getTime() <= at ? first.state : undefined;
    },

    async lastChangedTo(entity, value, since) {
      checkEntity("lastChangedTo", entity);
      const wanted = String(value);
      const now = clock.now();
      const start =
        since === undefined
          ? localMidnight(now, client.site()?.timeZone)
          : parseTime(since, now, "lastChangedTo", "start");
      const entries = await query(entity, start, now);
      // The first entry may be the state already in effect at `start`, not a change within.
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as HistoryEntry;
        if (entry.state !== wanted) {
          continue;
        }
        if (i === 0 && entry.at.getTime() === start) {
          return undefined;
        }
        return entry.at;
      }
      return undefined;
    },
  };
}
