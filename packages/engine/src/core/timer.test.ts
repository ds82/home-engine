import { describe, expect, it } from "vitest";
import { MAX_ARM_MS, hostClock, scheduleAt, type TimerHost } from "./timer.js";

/**
 * A host whose wall clock and timer queue move independently: `elapse` lets time pass
 * normally, `jump` changes only the wall clock (NTP correction, suspend).
 */
class FakeHost implements TimerHost {
  wall = Date.parse("2026-10-11T06:00:00.000Z");
  private mono = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  readonly armed: number[] = [];

  now(): number {
    return this.wall;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.armed.push(ms);
    const id = this.nextId++;
    this.timers.set(id, { at: this.mono + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Lets `ms` pass on both clocks, running due timers in order. */
  elapse(ms: number): void {
    const end = this.mono + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.wall += due[1].at - this.mono;
      this.mono = due[1].at;
      due[1].fn();
    }
    this.wall += end - this.mono;
    this.mono = end;
  }

  /** Changes only the wall clock. */
  jump(ms: number): void {
    this.wall += ms;
  }
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("scheduleAt", () => {
  it("runs a 30-day delay once, without ever arming more than 60 s", () => {
    const host = new FakeHost();
    let runs = 0;
    scheduleAt(host.now() + 30 * DAY, () => runs++, host);
    host.elapse(30 * DAY - 1);
    expect(runs).toBe(0);
    host.elapse(1);
    expect(runs).toBe(1);
    host.elapse(DAY);
    expect(runs).toBe(1);
    expect(Math.max(...host.armed)).toBeLessThanOrEqual(MAX_ARM_MS);
  });

  it("follows a forward clock jump: the corrected wall clock decides", () => {
    const host = new FakeHost();
    const target = Date.parse("2026-10-11T07:00:00.000Z");
    let ranAt: number | undefined;
    scheduleAt(target, () => (ranAt = host.now()), host);
    host.elapse(30 * MIN);
    host.jump(2 * MIN); // NTP moves the clock 2 minutes ahead
    host.elapse(27 * MIN);
    expect(ranAt).toBeUndefined();
    host.elapse(1 * MIN);
    expect(ranAt).toBe(target);
  });

  it("does not fire early when the clock jumps backward", () => {
    const host = new FakeHost();
    const target = host.now() + 10 * MIN;
    let runs = 0;
    scheduleAt(target, () => runs++, host);
    host.elapse(5 * MIN);
    host.jump(-30 * MIN);
    host.elapse(30 * MIN);
    expect(runs).toBe(0);
    host.elapse(5 * MIN);
    expect(runs).toBe(1);
  });

  it("fires within a minute after the host wakes from suspend past the target", () => {
    const host = new FakeHost();
    let runs = 0;
    scheduleAt(host.now() + 2 * 60 * MIN, () => runs++, host);
    host.elapse(10 * MIN);
    host.jump(5 * 60 * MIN); // suspended for 5 hours: wall clock moved, timers did not run
    expect(runs).toBe(0);
    host.elapse(MAX_ARM_MS);
    expect(runs).toBe(1);
  });

  it("can be cancelled, and runs immediately for a past target", () => {
    const host = new FakeHost();
    let runs = 0;
    const cancel = scheduleAt(host.now() + MIN, () => runs++, host);
    cancel();
    host.elapse(10 * MIN);
    expect(runs).toBe(0);
    scheduleAt(host.now() - 1, () => runs++, host);
    expect(runs).toBe(1);
  });
});

describe("hostClock", () => {
  it("waits relative durations against the wall clock", () => {
    const host = new FakeHost();
    const clock = hostClock(host);
    let runs = 0;
    clock.setTimeout(() => runs++, 90 * MIN);
    host.elapse(89 * MIN);
    expect(runs).toBe(0);
    host.elapse(MIN);
    expect(runs).toBe(1);
    expect(clock.now()).toBe(host.wall);
  });
});
