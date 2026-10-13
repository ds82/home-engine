// The timer primitive behind every timed wait (rule-scheduler: Clock drift and sleep
// robustness; design D6). A wait targets an absolute wall-clock time and arms setTimeout for
// at most 60 s at a time, re-checking the wall clock on every wake. That covers clock jumps
// (NTP corrections), host suspend and waits beyond setTimeout's ~24.8-day limit in one place.

import type { Logger } from "./logger.js";

/** Time as seen by rules: the wall clock and waits against it. */
export interface Clock {
  now(): number;
  /** Runs `fn` once `ms` of wall-clock time have passed; returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
}

/** The runtime's timers, injectable for tests. */
export interface TimerHost {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Longest single setTimeout; after it the wall clock is checked again. */
export const MAX_ARM_MS = 60_000;

const realHost: TimerHost = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = globalThis.setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * How late a time-trigger run may start. A later run (the host was suspended, say) is a
 * missed run: skipped like one missed while the engine was down, never replayed.
 */
export const LATE_LIMIT_MS = 60_000;

/**
 * True if a time-trigger run planned for `at` may still start at `now`. Otherwise logs the
 * skip at debug level; the caller re-arms from `now` either way.
 */
export function startsOnTime(at: number, now: number, trigger: string, log: Logger): boolean {
  const late = now - at;
  if (late <= LATE_LIMIT_MS) {
    return true;
  }
  const planned = new Date(at).toISOString();
  log.debug(
    { scheduledAt: planned, lateMs: late },
    `Skipped ${trigger} run planned for ${planned}: ${formatLate(late)} late`,
  );
  return false;
}

function formatLate(ms: number): string {
  if (ms >= 2 * 3_600_000) {
    return `${Math.floor(ms / 3_600_000)}h`;
  }
  if (ms >= 2 * 60_000) {
    return `${Math.floor(ms / 60_000)} min`;
  }
  return `${Math.floor(ms / 1000)} s`;
}

/** Runs `fn` once the wall clock reaches `target` (epoch ms). Returns a cancel function. */
export function scheduleAt(target: number, fn: () => void, host: TimerHost = realHost): () => void {
  let handle: unknown;
  let cancelled = false;
  const check = (): void => {
    if (cancelled) {
      return;
    }
    const remaining = target - host.now();
    if (remaining <= 0) {
      cancelled = true;
      fn();
      return;
    }
    handle = host.setTimeout(check, Math.min(remaining, MAX_ARM_MS));
  };
  check();
  return () => {
    cancelled = true;
    host.clearTimeout(handle);
  };
}

/** A Clock backed by `host` (the real timers by default). */
export function hostClock(host: TimerHost = realHost): Clock {
  return {
    now: () => host.now(),
    setTimeout: (fn, ms) => scheduleAt(host.now() + Math.max(0, ms), fn, host),
  };
}

export const realClock: Clock = hostClock();
