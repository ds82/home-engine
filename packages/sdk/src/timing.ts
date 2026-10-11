import type { TimerHandle } from "./rules.js";
import { notInEngine } from "./stub.js";
import type { Duration, SunEventName } from "./triggers.js";

/** Waits for a duration. Rejects when the run is aborted or the rule is unloaded. */
export function sleep(duration: Duration): Promise<void>;
export function sleep(): Promise<void> {
  return notInEngine("sleep");
}

/**
 * Runs `callback` once after `duration`. The returned handle cancels it; it is also cancelled
 * when the run is aborted or the rule is unloaded.
 */
export function after(duration: Duration, callback: () => unknown): TimerHandle;
export function after(): TimerHandle {
  return notInEngine("after");
}

/** A random integer between `min` and `max`, both included. */
export function randomInt(min: number, max: number): number;
export function randomInt(): number {
  return notInEngine("randomInt");
}

/** True while the sun is above the horizon at the Site. */
export function isSunUp(): boolean {
  return notInEngine("isSunUp");
}

/** True after today's local sunset (or, without a sunset today, while the sun is down). */
export function isAfterSunset(): boolean {
  return notInEngine("isAfterSunset");
}

/** True before today's local sunrise (or, without a sunrise today, while the sun is down). */
export function isBeforeSunrise(): boolean {
  return notInEngine("isBeforeSunrise");
}

/** The next time of a sun event at the Site, or undefined if none within a year. */
export function nextSun(event: SunEventName): Date | undefined;
export function nextSun(): Date | undefined {
  return notInEngine("nextSun");
}
