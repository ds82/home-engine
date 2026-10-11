// A manually advanced clock for hold tests: timers fire only when the test advances time.

import type { HoldClock } from "../state-triggers.js";

interface Timer {
  at: number;
  fn: () => void;
}

export class FakeClock implements HoldClock {
  private readonly timers = new Set<Timer>();

  constructor(private current = Date.parse("2026-10-11T12:00:00.000Z")) {}

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { at: this.current + ms, fn };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }

  /** Moves time forward, running every timer that becomes due, in order. */
  advance(ms: number): void {
    const end = this.current + ms;
    for (;;) {
      const due = [...this.timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.delete(due);
      this.current = Math.max(this.current, due.at);
      due.fn();
    }
    this.current = end;
  }

  /** ISO timestamp `ms` relative to now, for Home Assistant state timestamps. */
  iso(offsetMs = 0): string {
    return new Date(this.current + offsetMs).toISOString();
  }
}
