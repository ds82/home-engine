// A timer host whose wall clock and timer queue move independently, for testing the
// drift-proof Clock against clock jumps and host suspend.

import type { TimerHost } from "../timer.js";

/**
 * `elapse` lets time pass normally, `jump` changes only the wall clock (NTP correction,
 * suspend).
 */
export class FakeHost implements TimerHost {
  private mono = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  readonly armed: number[] = [];

  constructor(public wall = Date.parse("2026-10-11T06:00:00.000Z")) {}

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
      if (!due) {
        break;
      }
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
