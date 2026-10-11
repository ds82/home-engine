// Process-level safety net (rule-lifecycle: Error isolation; design D4). Rule code must never
// take the engine down: unhandled rejections and uncaught exceptions are logged and the
// process keeps running. Node runs these handlers in the async context of the failing code,
// so the error is attributed to the rule whose code caused it.

import type { Logger } from "./logger.js";
import { currentRun } from "./run-context.js";

/** Descriptions of write promises (service calls etc.), for messages about unawaited writes. */
const writes = new WeakMap<Promise<unknown>, string>();

/**
 * Registers a write promise (e.g. `light.turn_on → light.porch`). If it rejects and nobody
 * handles the rejection (the rule did not await it), the safety net logs it as a failed write
 * of the calling rule. A write the rule awaits and handles is never logged twice.
 */
export function trackWrite<T>(promise: Promise<T>, description: string): Promise<T> {
  writes.set(promise, description);
  return promise;
}

export interface SafetyNet {
  uninstall(): void;
}

export function installSafetyNet(log: Logger, target: NodeJS.Process = process): SafetyNet {
  const onRejection = (reason: unknown, promise: Promise<unknown>): void => {
    const run = currentRun();
    const logger = run?.scope.log ?? log;
    run?.scope.recordError(reason);
    const write = writes.get(promise);
    if (write) {
      logger.error(
        { err: reason, write },
        `Write failed (not awaited): ${write}: ${message(reason)}`,
      );
    } else {
      logger.error({ err: reason }, "Unhandled promise rejection");
    }
  };
  const onException = (err: Error): void => {
    const run = currentRun();
    run?.scope.recordError(err);
    (run?.scope.log ?? log).error({ err }, "Uncaught exception");
  };
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  return {
    uninstall: () => {
      target.off("unhandledRejection", onRejection);
      target.off("uncaughtException", onException);
    },
  };
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
