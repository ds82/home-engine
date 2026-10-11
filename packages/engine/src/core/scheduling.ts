// Delays and intervals for rules (rule-scheduler: Delay, Interval). All waits go through the
// drift-proof Clock. sleep and after belong to the calling run: a restart-mode abort or the
// rule's unload cancels them. The every trigger fires on a fixed grid of absolute times, so
// it does not drift with the time its bodies take.

import type { Duration, TimerHandle, Weekday } from "@home-engine/sdk";
import { Cron } from "croner";
import { parseDuration } from "./duration.js";
import { requireRun, invoke } from "./run-context.js";
import type { Clock } from "./timer.js";
import { parseLocalTime, weekdayNumbers } from "./trigger-constructors.js";
import type { TriggerSource, TriggerSources } from "./trigger-source.js";

export interface SchedulingOptions {
  clock: Clock;
  /** The Site's IANA time zone (TIME_ZONE override first); undefined = system time zone. */
  timeZone: () => string | undefined;
  /** Called when the Site changes (e.g. its time zone); armed schedules are recomputed. */
  onSiteChange?: (listener: () => void) => () => void;
}

export interface Scheduling {
  sleep(duration: Duration): Promise<void>;
  after(duration: Duration, callback: () => void | Promise<void>): TimerHandle;
  randomInt(min: number, max: number): number;
  /** Trigger source for `every`. */
  everySource: TriggerSource;
  /** Trigger sources for all time triggers (`every`, `daily`, `cron`). */
  sources: TriggerSources;
}

export function createScheduling({ clock, timeZone, onSiteChange }: SchedulingOptions): Scheduling {
  function sleep(duration: Duration): Promise<void> {
    const ms = parseDuration(duration, "sleep() duration");
    const { signal } = requireRun("sleep");
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = (): void => {
        cancel();
        reject(signal.reason);
      };
      const cancel = clock.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function after(duration: Duration, callback: () => void | Promise<void>): TimerHandle {
    const ms = parseDuration(duration, "after() duration");
    if (typeof callback !== "function")
      throw new TypeError("after(): the callback must be a function");
    const { scope, signal } = requireRun("after");
    let nextRun: Date | undefined = new Date(clock.now() + ms);
    const cancelTimer = clock.setTimeout(() => {
      nextRun = undefined;
      signal.removeEventListener("abort", cancel);
      invoke(scope, "callback", () => callback());
    }, ms);
    function cancel(): void {
      if (!nextRun) return;
      nextRun = undefined;
      cancelTimer();
      signal.removeEventListener("abort", cancel);
    }
    signal.addEventListener("abort", cancel, { once: true });
    return {
      cancel,
      get nextRun() {
        return nextRun;
      },
    };
  }

  function randomInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new TypeError(`randomInt(): expected integers with min <= max, got ${min} and ${max}`);
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  const everySource: TriggerSource = (trigger, context) => {
    if (trigger.kind !== "every") throw new Error(`every source cannot arm ${trigger.kind}`);
    const interval = parseDuration(trigger.interval);
    // The grid passes through the alignTo time (in the Site's time zone) or the start time.
    const anchor = trigger.alignTo
      ? nextLocalTime(trigger.alignTo, timeZone(), clock.now())
      : clock.now();
    const firstAfter = (now: number): number =>
      anchor + Math.floor((now - anchor) / interval + 1) * interval;

    let cancel: () => void = () => {};
    let stopped = false;
    const fireAt = (at: number): void => {
      context.fire({ type: "time", scheduledAt: new Date(at) });
    };
    const armNext = (after: number): void => {
      const at = firstAfter(after);
      cancel = clock.setTimeout(() => {
        if (stopped) return;
        fireAt(at);
        armNext(at);
      }, at - clock.now());
    };
    if (trigger.immediate) fireAt(clock.now());
    armNext(clock.now());
    return {
      dispose: () => {
        stopped = true;
        cancel();
      },
    };
  };

  /**
   * `daily` and `cron`: wait for the next run computed in the Site's time zone, fire, repeat.
   * The next run is always computed from now, so runs missed while the engine was down are
   * not replayed. A Site change recomputes the pending run.
   */
  const calendarSource: TriggerSource = (trigger, context) => {
    if (trigger.kind !== "daily" && trigger.kind !== "cron") {
      throw new Error(`calendar source cannot arm ${trigger.kind}`);
    }
    const next = (after: number): number | undefined =>
      trigger.kind === "daily"
        ? nextDaily(trigger.time, trigger.weekdays, timeZone(), after)
        : new Cron(trigger.expression, tzOption(timeZone())).nextRun(new Date(after))?.getTime();

    let cancel: () => void = () => {};
    let stopped = false;
    const arm = (after: number): void => {
      cancel();
      const at = next(after);
      if (at === undefined || stopped) return;
      cancel = clock.setTimeout(() => {
        if (stopped) return;
        context.fire({ type: "time", scheduledAt: new Date(at) });
        arm(at);
      }, at - clock.now());
    };
    arm(clock.now());
    const offSite = onSiteChange?.(() => arm(clock.now()));
    return {
      dispose: () => {
        stopped = true;
        cancel();
        offSite?.();
      },
    };
  };

  const sources: TriggerSources = {
    every: everySource,
    daily: calendarSource,
    cron: calendarSource,
  };
  return { sleep, after, randomInt, everySource, sources };
}

function tzOption(timeZone: string | undefined): { timezone?: string } {
  return timeZone ? { timezone: timeZone } : {};
}

/**
 * Next run of a daily time, strictly after `after`. On a DST spring-forward day a time inside
 * the gap does not exist; it then runs once at the first valid instant after the gap.
 */
export function nextDaily(
  time: string,
  weekdays: readonly Weekday[] | undefined,
  timeZone: string | undefined,
  after: number,
): number | undefined {
  const { h, m, s } = parseLocalTime(time, "daily()");
  const dow = weekdays ? weekdayNumbers(weekdays).join(",") : "*";
  const next = new Cron(`${s} ${m} ${h} * * ${dow}`, tzOption(timeZone)).nextRun(new Date(after));
  if (!next) return undefined;
  const at = next.getTime();
  const wanted = h * 3600 + m * 60 + s;
  if (localSeconds(at, timeZone) === wanted) return at;
  // Shifted by a DST gap: find the instant the local clock jumped past the wanted time.
  let lo = at - 3 * 3600_000;
  let hi = at;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localSeconds(mid, timeZone) >= wanted && sameLocalDay(mid, at, timeZone)) hi = mid;
    else lo = mid;
  }
  return Math.max(hi, after + 1);
}

function localParts(at: number, timeZone: string | undefined): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

function localSeconds(at: number, timeZone: string | undefined): number {
  const p = localParts(at, timeZone);
  return Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
}

function sameLocalDay(a: number, b: number, timeZone: string | undefined): boolean {
  const pa = localParts(a, timeZone);
  const pb = localParts(b, timeZone);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/** Epoch ms of the next occurrence of a local "HH:MM[:SS]" in `timeZone`, strictly after `now`. */
export function nextLocalTime(time: string, timeZone: string | undefined, now: number): number {
  const { h, m, s } = parseLocalTime(time, "time");
  const cron = new Cron(`${s} ${m} ${h} * * *`, timeZone ? { timezone: timeZone } : {});
  const next = cron.nextRun(new Date(now));
  if (!next) throw new Error(`No next occurrence of ${time}`);
  return next.getTime();
}
