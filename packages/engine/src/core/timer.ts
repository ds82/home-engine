// The timer primitive behind every timed wait (rule-scheduler: Clock drift and sleep
// robustness; design D6). A wait targets an absolute wall-clock time and arms setTimeout for
// at most 60 s at a time, re-checking the wall clock on every wake. That covers clock jumps
// (NTP corrections), host suspend and waits beyond setTimeout's ~24.8-day limit in one place.

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

/** Runs `fn` once the wall clock reaches `target` (epoch ms). Returns a cancel function. */
export function scheduleAt(target: number, fn: () => void, host: TimerHost = realHost): () => void {
  let handle: unknown;
  let cancelled = false;
  const check = (): void => {
    if (cancelled) return;
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
