// Logging and teardown for rule code.

import { notInEngine } from "./stub.js";

type LogFunction = (message: string | Error, fields?: Record<string, unknown>) => void;

/** A logger whose lines are tagged with the calling rule's ID. */
export interface RuleLogger {
  trace: LogFunction;
  debug: LogFunction;
  info: LogFunction;
  warn: LogFunction;
  error: LogFunction;
  fatal: LogFunction;
}

const stub: LogFunction = () => notInEngine("log");

/** `log.info("turned on", { entity: "light.porch" })`; tagged with the rule ID. */
export const log: RuleLogger = {
  trace: stub,
  debug: stub,
  info: stub,
  warn: stub,
  error: stub,
  fatal: stub,
};

/**
 * Registers a teardown that runs when the calling rule is unloaded (reload, disable,
 * shutdown), newest first. Setup functions can also return their teardown.
 */
export function onDispose(teardown: () => void | Promise<void>): void;
export function onDispose(): void {
  notInEngine("onDispose");
}
