import type { TimerHandle } from "./rules.js";
import { notInEngine } from "./stub.js";
import type { Duration } from "./triggers.js";

/** Waits for a duration. Rejects when the run is aborted or the rule is unloaded. */
export function sleep(duration: Duration): Promise<void>;
export function sleep(): Promise<void> {
  return notInEngine("sleep");
}

/**
 * Runs `callback` once after `duration`. The returned handle cancels it; it is also cancelled
 * when the run is aborted or the rule is unloaded.
 */
export function after(duration: Duration, callback: () => void | Promise<void>): TimerHandle;
export function after(): TimerHandle {
  return notInEngine("after");
}

/** A random integer between `min` and `max`, both included. */
export function randomInt(min: number, max: number): number;
export function randomInt(): number {
  return notInEngine("randomInt");
}
