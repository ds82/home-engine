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
}

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

  const range = (fn: string, since: unknown, until: unknown): { start: number; end: number } => {
    const now = clock.now();
    const start = parseTime(since, now, fn, "start");
    const end = until === undefined ? now : parseTime(until, now, fn, "end");
    if (end < start) throw new RangeError(`${fn}(): the end lies before the start`);
    return { start, end };
  };

  return {
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
