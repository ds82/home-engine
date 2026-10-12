// Concurrency modes for the runs of one triggered rule (rule-triggers: Concurrency modes).
// Listeners of setup rules use `parallel` without a limit.

import type { ConcurrencyMode } from "@home-engine/sdk";
import type { Logger } from "./logger.js";
import type { Run } from "./run-context.js";

export const QUEUED_DEFAULT_MAX = 10;

/** Starts one run; called by the controller when the run may start. */
export type StartRun = () => Run;

export class ConcurrencyController {
  private readonly active = new Set<Run>();
  private readonly waiting: StartRun[] = [];
  private readonly max: number;

  constructor(
    private readonly mode: ConcurrencyMode,
    max: number | undefined,
    private readonly log: Logger,
  ) {
    this.max = max ?? (mode === "queued" ? QUEUED_DEFAULT_MAX : Number.POSITIVE_INFINITY);
  }

  /** Runs in progress plus runs waiting in the queue. */
  get pending(): number {
    return this.active.size + this.waiting.length;
  }

  submit(start: StartRun): void {
    switch (this.mode) {
      case "parallel":
        if (this.active.size >= this.max) {
          return this.drop("parallel");
        }
        return this.launch(start);
      case "single":
        if (this.active.size > 0) {
          this.log.debug("Dropped a firing: mode single and the previous run is still in progress");
          return;
        }
        return this.launch(start);
      case "queued":
        if (this.pending >= this.max) {
          return this.drop("queued");
        }
        if (this.active.size === 0) {
          return this.launch(start);
        }
        this.waiting.push(start);
        return;
      case "restart":
        for (const run of this.active) {
          run.abort();
        }
        return this.launch(start);
    }
  }

  /** Aborts every run and forgets queued ones (used on unload). */
  cancelAll(): void {
    this.waiting.length = 0;
    for (const run of this.active) {
      run.abort();
    }
  }

  private launch(start: StartRun): void {
    const run = start();
    this.active.add(run);
    void run.done.then(() => {
      this.active.delete(run);
      const next = this.waiting.shift();
      if (next) {
        this.launch(next);
      }
    });
  }

  private drop(mode: string): void {
    this.log.warn(
      { mode, max: this.max },
      `Dropped a firing: ${this.pending} runs already in progress or queued (max ${this.max})`,
    );
  }
}
