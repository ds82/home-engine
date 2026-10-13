// Logging and teardown for rule code.

import { notInEngine } from "./stub.js";

/**
 * Logs one line at the method's level. For an `Error`, its message is the line and the error
 * itself (with its stack) is added as the `err` field. `fields` are added as structured data.
 * @inline
 */
type LogFunction = (message: string | Error, fields?: Record<string, unknown>) => void;

/**
 * A logger whose lines are tagged with the calling rule's ID.
 * @category Logging
 */
export interface RuleLogger {
  /** Logs at level `trace`, the most detailed. */
  trace: LogFunction;
  /** Logs at level `debug`. */
  debug: LogFunction;
  /** Logs at level `info`, the default level of `LOG_LEVEL`. */
  info: LogFunction;
  /** Logs at level `warn`. */
  warn: LogFunction;
  /** Logs at level `error`. */
  error: LogFunction;
  /** Logs at level `fatal`, the most severe. It does not stop the rule or the engine. */
  fatal: LogFunction;
}

const stub: LogFunction = () => notInEngine("log");

/**
 * `log.info("turned on", { entity: "light.porch" })`; tagged with the rule ID.
 * @category Logging
 */
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
 * @category Rules
 */
export function onDispose(teardown: () => void | Promise<void>): void;
export function onDispose(): void {
  notInEngine("onDispose");
}
