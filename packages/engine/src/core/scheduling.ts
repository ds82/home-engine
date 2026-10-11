// Delays and intervals for rules (rule-scheduler: Delay, Interval). All waits go through the
// drift-proof Clock. sleep and after belong to the calling run: a restart-mode abort or the
// rule's unload cancels them. The every trigger fires on a fixed grid of absolute times, so
// it does not drift with the time its bodies take.

import type { Duration, TimerHandle } from "@home-engine/sdk";
import { Cron } from "croner";
import { parseDuration } from "./duration.js";
import { requireRun, invoke } from "./run-context.js";
import type { Clock } from "./timer.js";
import { parseLocalTime } from "./trigger-constructors.js";
import type { TriggerSource } from "./trigger-source.js";

export interface SchedulingOptions {
  clock: Clock;
  /** The Site's IANA time zone (TIME_ZONE override first); undefined = system time zone. */
  timeZone: () => string | undefined;
}

export interface Scheduling {
  sleep(duration: Duration): Promise<void>;
  after(duration: Duration, callback: () => void | Promise<void>): TimerHandle;
  randomInt(min: number, max: number): number;
  /** Trigger source for `every`. */
  everySource: TriggerSource;
}

export function createScheduling({ clock, timeZone }: SchedulingOptions): Scheduling {
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

  return { sleep, after, randomInt, everySource };
}

/** Epoch ms of the next occurrence of a local "HH:MM[:SS]" in `timeZone`, strictly after `now`. */
export function nextLocalTime(time: string, timeZone: string | undefined, now: number): number {
  const { h, m, s } = parseLocalTime(time, "time");
  const cron = new Cron(`${s} ${m} ${h} * * *`, timeZone ? { timezone: timeZone } : {});
  const next = cron.nextRun(new Date(now));
  if (!next) throw new Error(`No next occurrence of ${time}`);
  return next.getTime();
}
