// Core trigger constructors. Like all constructors they only build a frozen descriptor;
// the engine arms it when the rule starts.

import type {
  CronTrigger,
  DailyTrigger,
  EveryTrigger,
  StartupTrigger,
  Weekday,
} from "@home-engine/sdk";
import { Cron } from "croner";
import { parseDuration } from "./duration.js";

/** SDK `onStartup()`: fires once each time the rule starts. */
export function onStartup(...args: unknown[]): StartupTrigger {
  if (args.length > 0) throw new TypeError("onStartup() takes no arguments");
  return Object.freeze({ kind: "startup" });
}

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** Parses "HH:MM" or "HH:MM:SS"; throws for anything else. */
export function parseLocalTime(value: unknown, what: string): { h: number; m: number; s: number } {
  const match = typeof value === "string" ? LOCAL_TIME.exec(value) : null;
  if (!match)
    throw new TypeError(
      `${what}: ${JSON.stringify(value)} is not a time like "07:30" or "07:30:15"`,
    );
  return { h: Number(match[1]), m: Number(match[2]), s: Number(match[3] ?? 0) };
}

/** SDK `every(interval, options?)`: fires repeatedly after the rule starts. */
export function every(interval: unknown, options: unknown = {}): EveryTrigger {
  const ms = parseDuration(interval, "every() interval");
  if (ms <= 0) throw new TypeError("every(): the interval must be longer than 0");
  if (options === null || typeof options !== "object")
    throw new TypeError("every(): options must be an object");
  const o = options as { alignTo?: unknown; immediate?: unknown };
  for (const key of Object.keys(o)) {
    if (key !== "alignTo" && key !== "immediate")
      throw new TypeError(`every(): unknown option "${key}"`);
  }
  if (o.alignTo !== undefined) parseLocalTime(o.alignTo, "every() alignTo");
  if (o.immediate !== undefined && typeof o.immediate !== "boolean") {
    throw new TypeError("every(): immediate must be true or false");
  }
  const trigger: {
    kind: "every";
    interval: number | string;
    alignTo?: string;
    immediate?: boolean;
  } = {
    kind: "every",
    interval: interval as number | string,
  };
  if (o.alignTo !== undefined) trigger.alignTo = o.alignTo as string;
  if (o.immediate !== undefined) trigger.immediate = o.immediate as boolean;
  return Object.freeze(trigger);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** SDK `cron(expression)`: a 5-field or 6-field (with seconds) cron expression. */
export function cron(expression: unknown): CronTrigger {
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new TypeError("cron(): the expression must be a non-empty string");
  }
  const fields = expression.trim().split(/\s+/).length;
  if (fields !== 5 && fields !== 6) {
    throw new TypeError(`cron(): "${expression}" has ${fields} fields; use 5 (or 6 with seconds)`);
  }
  try {
    new Cron(expression, { paused: true });
  } catch (err) {
    throw new TypeError(`cron(): invalid expression "${expression}": ${(err as Error).message}`, {
      cause: err,
    });
  }
  return Object.freeze({ kind: "cron", expression });
}

/** SDK `daily(time, options?)`: every day at a local time, optionally on some weekdays. */
export function daily(time: unknown, options: unknown = {}): DailyTrigger {
  parseLocalTime(time, "daily()");
  if (options === null || typeof options !== "object")
    throw new TypeError("daily(): options must be an object");
  const o = options as { weekdays?: unknown };
  for (const key of Object.keys(o)) {
    if (key !== "weekdays") throw new TypeError(`daily(): unknown option "${key}"`);
  }
  if (o.weekdays === undefined) return Object.freeze({ kind: "daily", time: time as string });
  if (
    !Array.isArray(o.weekdays) ||
    o.weekdays.length === 0 ||
    !o.weekdays.every((d) => (WEEKDAYS as readonly unknown[]).includes(d))
  ) {
    throw new TypeError(`daily(): weekdays must be a non-empty list of ${WEEKDAYS.join(", ")}`);
  }
  return Object.freeze({
    kind: "daily",
    time: time as string,
    weekdays: Object.freeze([...new Set(o.weekdays as Weekday[])]),
  });
}

/** Weekday names → cron day-of-week numbers (0 = Sunday). */
export function weekdayNumbers(weekdays: readonly Weekday[]): number[] {
  return weekdays.map((d) => WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
}
