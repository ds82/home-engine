import type { EntityId, EntityOf } from "./entities.js";
import { notInEngine } from "./stub.js";
import type { Duration, ValueFilter } from "./triggers.js";

export interface WaitFilter {
  /** Previous value (a transition is required). */
  from?: ValueFilter;
  /** Value to wait for. */
  to?: ValueFilter;
  /** Wait on this attribute instead of the state value. */
  attribute?: string;
}

export interface WaitOptions {
  /** Give up after this long; the promise then resolves with undefined. */
  timeout?: Duration;
  /** The entity must keep matching for this long. */
  for?: Duration;
}

/**
 * Waits until an entity matches `filter`. Resolves with its state, or with undefined on
 * timeout. Rejects only when the run is aborted or the rule is unloaded.
 */
export function waitFor<Id extends EntityId>(
  entity: Id,
  filter: WaitFilter,
  options?: WaitOptions,
): Promise<EntityOf<Id> | undefined>;
export function waitFor(): Promise<undefined> {
  return notInEngine("waitFor");
}
