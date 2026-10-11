// What a started rule owns (design D4 "Per-rule resource scope"): an AbortController that
// fires on unload, user teardowns, and internal disposers for everything created on the
// rule's behalf (subscriptions, timers, ...). Unloading runs user teardowns (newest first),
// then aborts the signal, then runs the disposers (newest first). Every step is isolated:
// a throwing teardown is logged and the rest still runs.

import type { Logger } from "./logger.js";

export interface RuleScope {
  readonly ruleId: string;
  /** Aborted when the rule is unloaded. */
  readonly signal: AbortSignal;
  /**
   * Registers an internal cleanup that runs when the rule is unloaded, after user teardowns
   * and the abort (newest first). Registered after unload, it runs immediately. Returns a
   * function that unregisters it (for resources released earlier, like a fired timer).
   */
  onDispose(dispose: () => void | Promise<void>): () => void;
}

/** Abort reason for an unloaded rule; treated like an AbortError by the engine. */
export class RuleUnloadedError extends Error {
  constructor(ruleId: string) {
    super(`Rule ${ruleId} was unloaded`);
    this.name = "AbortError";
  }
}

type Cleanup = () => void | Promise<void>;

export class RuleScopeImpl implements RuleScope {
  readonly log: Logger;
  private readonly controller = new AbortController();
  private readonly teardowns: Cleanup[] = [];
  private readonly disposers = new Set<Cleanup>();
  private disposing: Promise<void> | undefined;

  /** Time the last run started. */
  lastRunAt: Date | undefined;
  /** Last error of a body, setup function or callback. */
  lastError: Error | undefined;

  constructor(
    readonly ruleId: string,
    log: Logger,
  ) {
    this.log = log.child({ source: ruleId });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this.disposing !== undefined;
  }

  /** A user teardown (SDK `onDispose()` or the function a setup function returns). */
  addTeardown(teardown: Cleanup): void {
    if (this.disposed) {
      void this.runSafely(teardown, "teardown");
      return;
    }
    this.teardowns.push(teardown);
  }

  onDispose(dispose: Cleanup): () => void {
    if (this.disposed) {
      void this.runSafely(dispose, "cleanup");
      return () => {};
    }
    // Wrapped so registering the same function twice yields two independent entries.
    const entry: Cleanup = () => dispose();
    this.disposers.add(entry);
    return () => {
      this.disposers.delete(entry);
    };
  }

  /** Unloads the rule. Safe to call more than once; later calls await the first. */
  dispose(): Promise<void> {
    this.disposing ??= this.runDispose();
    return this.disposing;
  }

  recordError(err: unknown): void {
    this.lastError = err instanceof Error ? err : new Error(String(err));
  }

  private async runDispose(): Promise<void> {
    for (const teardown of this.teardowns.splice(0).reverse()) {
      await this.runSafely(teardown, "teardown");
    }
    this.controller.abort(new RuleUnloadedError(this.ruleId));
    const disposers = [...this.disposers].reverse();
    this.disposers.clear();
    for (const dispose of disposers) {
      await this.runSafely(dispose, "cleanup");
    }
  }

  private async runSafely(fn: Cleanup, what: "teardown" | "cleanup"): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.recordError(err);
      this.log.error({ err }, what === "teardown" ? "Teardown failed" : "Cleanup failed");
    }
  }
}
