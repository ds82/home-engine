// History queries on Home Assistant's recorder. Points in time are a Date, an ISO 8601
// string, or a duration meaning "that long ago" ("24h", "7d"); the end defaults to now.

import type { EntityId } from "./entities.js";
import { notInEngine } from "./stub.js";

/**
 * A point in time: a Date, an ISO 8601 string, or a duration ago such as `"24h"`.
 * @category History
 */
export type TimeArg = Date | string;

/**
 * A recorded state and the time it took effect.
 * @category History
 */
export interface HistoryEntry {
  /** The state value. */
  state: string;
  /** When the state took effect, or `since` for the state already in effect then. */
  at: Date;
}

/**
 * The entity's recorded state changes in the range, oldest first. The first entry is the
 * state in effect at `since` (dated `since`), if one is recorded.
 * @category History
 */
export function history(entity: EntityId, since: TimeArg, until?: TimeArg): Promise<HistoryEntry[]>;
export function history(): Promise<HistoryEntry[]> {
  return notInEngine("history");
}

/**
 * The state in effect at `time`, or undefined if none is recorded.
 * @category History
 */
export function stateAt(entity: EntityId, time: TimeArg): Promise<string | undefined>;
export function stateAt(): Promise<string | undefined> {
  return notInEngine("stateAt");
}

/**
 * The most recent time the entity changed to `value` since `since` (default: local midnight),
 * or undefined if it did not.
 * @category History
 */
export function lastChangedTo(
  entity: EntityId,
  value: string | number | boolean,
  since?: TimeArg,
): Promise<Date | undefined>;
export function lastChangedTo(): Promise<Date | undefined> {
  return notInEngine("lastChangedTo");
}

/**
 * Time-weighted average of the entity's numeric states over the range. Non-numeric states
 * (`unknown`, `unavailable`) are left out; undefined if there is no numeric state. Ranges
 * older than the recorder's history are filled from long-term statistics.
 * @category History
 */
export function averageSince(
  entity: EntityId,
  since: TimeArg,
  until?: TimeArg,
): Promise<number | undefined>;
export function averageSince(): Promise<number | undefined> {
  return notInEngine("averageSince");
}

/**
 * Lowest numeric state over the range; undefined if there is none.
 * @category History
 */
export function minimumSince(
  entity: EntityId,
  since: TimeArg,
  until?: TimeArg,
): Promise<number | undefined>;
export function minimumSince(): Promise<number | undefined> {
  return notInEngine("minimumSince");
}

/**
 * Highest numeric state over the range; undefined if there is none.
 * @category History
 */
export function maximumSince(
  entity: EntityId,
  since: TimeArg,
  until?: TimeArg,
): Promise<number | undefined>;
export function maximumSince(): Promise<number | undefined> {
  return notInEngine("maximumSince");
}

/**
 * How much a cumulative sensor (state class `total` or `total_increasing`, e.g. an energy
 * meter) rose over the range, from Home Assistant's hourly statistics, which account for meter
 * resets. Counts from the first full hour after `since`; when the range ends now, the current
 * hour is added from the live reading. Undefined without statistics.
 * @category History
 */
export function changeSince(
  entity: EntityId,
  since: TimeArg,
  until?: TimeArg,
): Promise<number | undefined>;
export function changeSince(): Promise<number | undefined> {
  return notInEngine("changeSince");
}

/**
 * The length of one period of long-term statistics.
 * @category History
 */
export type StatisticPeriod = "5minute" | "hour" | "day" | "week" | "month";
/**
 * A value Home Assistant keeps per statistics period; see {@link StatisticsEntry}.
 * @category History
 */
export type StatisticType = "mean" | "min" | "max" | "sum" | "state" | "change";

/**
 * Options of {@link statistics}.
 * @category History
 */
export interface StatisticsOptions {
  /** Start of the range. */
  since: TimeArg;
  /** End of the range; default now. */
  until?: TimeArg;
  /** Default `hour`. */
  period?: StatisticPeriod;
  /** Default `mean`, `min` and `max`. */
  types?: readonly StatisticType[];
}

/**
 * One period of long-term statistics; only the requested types are present.
 * @category History
 */
export interface StatisticsEntry {
  /** Start of the period. */
  start: Date;
  /** End of the period. */
  end: Date;
  /** Time-weighted average over the period (measurement sensors). */
  mean?: number;
  /** Lowest value in the period (measurement sensors). */
  min?: number;
  /** Highest value in the period (measurement sensors). */
  max?: number;
  /** Running total at the end of the period, across meter resets (cumulative sensors). */
  sum?: number;
  /** The meter's reading at the end of the period (cumulative sensors). */
  state?: number;
  /** How much the total rose during the period (cumulative sensors). */
  change?: number;
}

/**
 * Home Assistant's long-term statistics for a statistic ID (usually the entity ID).
 * @category History
 */
export function statistics(
  statisticId: EntityId | `${string}:${string}`,
  options: StatisticsOptions,
): Promise<StatisticsEntry[]>;
export function statistics(): Promise<StatisticsEntry[]> {
  return notInEngine("statistics");
}
