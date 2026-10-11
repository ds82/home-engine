// History queries (ha-history; design D15) on Home Assistant's recorder:
// `history/history_during_period` for `history`, `stateAt` and `lastChangedTo`.
// Points in time are a Date, an ISO 8601 string, or a duration meaning "that long ago".

import { parseDuration } from "../../core/duration.js";
import { nextLocalTime } from "../../core/scheduling.js";
import type { Clock } from "../../core/timer.js";
import { realClock } from "../../core/timer.js";
import type { HaClient } from "./client.js";
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
    if (ms <= 0) continue;
    weighted += seg.mean * ms;
    duration += ms;
    minimum = minimum === undefined ? seg.min : Math.min(minimum, seg.min);
    maximum = maximum === undefined ? seg.max : Math.max(maximum, seg.max);
  }
  return { average: duration > 0 ? weighted / duration : undefined, minimum, maximum };
}

/** A state as a number, or undefined for `unknown`, `unavailable` and other text. */
export function numericState(state: string): number | undefined {
  if (state.trim() === "") return undefined;
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
}

const epochMs = (t: number | string): number => (typeof t === "number" ? t : Date.parse(t));

/** A row of the compressed history format (`minimal_response`, `no_attributes`). */
interface CompressedRow {
  s: string;
  /** last_updated, epoch seconds. */
  lu: number;
  /** last_changed, epoch seconds; omitted when equal to lu. */
  lc?: number;
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
    if (!Number.isNaN(value.getTime())) return value.getTime();
  } else if (typeof value === "string") {
    try {
      return now - parseDuration(value);
    } catch {
      // Not a duration: try ISO 8601.
    }
    const at = Date.parse(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(value.trim()) && !Number.isNaN(at)) return at;
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
    if (next > now) return midnight;
    midnight = next;
  }
}

export function createHistory(client: HaClient, clock: Clock = realClock): HistoryQueries {
  /**
   * State changes of `entity` in [start, end), oldest first. The first entry is the state in
   * effect at `start` (if recorded), dated `start`. Rows that repeat the previous state
   * (attribute-only updates) are dropped.
   */
  async function query(entity: string, start: number, end: number): Promise<HistoryEntry[]> {
    const session = client.connection.current;
    if (!session || !client.isReady) throw new NotConnectedError(`history of ${entity}`);
    const result = await session.command<Record<string, CompressedRow[] | undefined>>({
      type: "history/history_during_period",
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      entity_ids: [entity],
      include_start_time_state: true,
      significant_changes_only: false,
      minimal_response: true,
      no_attributes: true,
    });
    const entries: HistoryEntry[] = [];
    for (const row of result[entity] ?? []) {
      if (entries.at(-1)?.state === row.s) continue;
      const at = Math.max(start, Math.round((row.lc ?? row.lu) * 1000));
      entries.push({ state: row.s, at: new Date(at) });
    }
    return entries;
  }

  /** Hourly long-term statistics clipped to [start, end), as segments. */
  async function statisticsSegments(
    entity: string,
    start: number,
    end: number,
  ): Promise<Segment[]> {
    const session = client.connection.current;
    if (!session || !client.isReady) throw new NotConnectedError(`statistics of ${entity}`);
    // Hourly rows start on the hour: begin at the hour containing `start`.
    const from = Math.floor(start / 3_600_000) * 3_600_000;
    const result = await session.command<Record<string, StatisticsRow[] | undefined>>({
      type: "recorder/statistics_during_period",
      start_time: new Date(from).toISOString(),
      end_time: new Date(end).toISOString(),
      statistic_ids: [entity],
      period: "hour",
      types: ["mean", "min", "max"],
    });
    const segments: Segment[] = [];
    for (const row of result[entity] ?? []) {
      const { mean, min, max } = row;
      if (typeof mean !== "number" || typeof min !== "number" || typeof max !== "number") continue;
      const segFrom = Math.max(start, epochMs(row.start));
      const segTo = Math.min(end, epochMs(row.end));
      if (segTo > segFrom) segments.push({ from: segFrom, to: segTo, mean, min, max });
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
      if (value === undefined) return;
      const next = entries[i + 1];
      const to = next ? next.at.getTime() : end;
      segments.push({ from: entry.at.getTime(), to, mean: value, min: value, max: value });
    });
    const covered = entries[0]?.at.getTime() ?? end;
    if (covered > start) segments.unshift(...(await statisticsSegments(entity, start, covered)));
    return segments;
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
    if (end < start) throw new RangeError(`${fn}(): the end lies before the start`);
    return { start, end };
  };

  return {
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
        if (entry.state !== wanted) continue;
        if (i === 0 && entry.at.getTime() === start) return undefined;
        return entry.at;
      }
      return undefined;
    },
  };
}
