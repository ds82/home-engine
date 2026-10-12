// Controllable replacement for the connection's backoff delay: tests see every requested
// delay and decide when it elapses, so no real waiting and no flaky timing.

export interface PendingDelay {
  ms: number;
  release: () => void;
}

export class FakeDelay {
  /** Every delay requested so far, in order. */
  readonly requested: number[] = [];
  private queue: PendingDelay[] = [];
  private waiters: Array<(d: PendingDelay) => void> = [];

  readonly delay = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      this.requested.push(ms);
      const onAbort = (): void => reject(signal.reason as Error);
      signal.addEventListener("abort", onAbort, { once: true });
      const pending: PendingDelay = {
        ms,
        release: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(pending);
      } else {
        this.queue.push(pending);
      }
    });

  /** Resolves with the next requested delay (already requested or upcoming). */
  next(): Promise<PendingDelay> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Waits for the next delay and lets it elapse; returns its length. */
  async elapseNext(): Promise<number> {
    const d = await this.next();
    d.release();
    return d.ms;
  }
}
