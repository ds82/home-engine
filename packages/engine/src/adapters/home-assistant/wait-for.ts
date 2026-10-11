// `waitFor(entity, filter, options?)` (rule-triggers: Await a state). Resolves with the
// entity's state once it matches the filter (optionally held for `for`), resolves with
// undefined on timeout, and rejects only when the calling run is aborted or its rule is
// unloaded. Uses the same change semantics as onChange.

import type { StateTrigger, ValueFilter } from "@home-engine/sdk";
import { parseDuration } from "../../core/duration.js";
import { requireRun } from "../../core/run-context.js";
import type { HaClient } from "./client.js";
import { realClock, StateMatcher, type HoldClock } from "./state-triggers.js";
import type { HaState } from "./types.js";

export interface WaitFilter {
  from?: ValueFilter;
  to?: ValueFilter;
  attribute?: string;
}

export interface WaitOptions {
  /** Give up after this long and resolve with undefined. */
  timeout?: number | string;
  /** The entity must keep matching for this long. */
  for?: number | string;
}

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/i;
const FILTER_KEYS = new Set(["from", "to", "attribute"]);

export type WaitFor = (
  entity: string,
  filter: WaitFilter,
  options?: WaitOptions,
) => Promise<HaState | undefined>;

export function createWaitFor(client: HaClient, clock: HoldClock = realClock): WaitFor {
  return (entity, filter, options = {}) => {
    // Validate synchronously: a typo throws at the call site.
    if (typeof entity !== "string" || !ENTITY_ID.test(entity)) {
      throw new TypeError(`waitFor(): ${JSON.stringify(entity)} is not an entity ID`);
    }
    if (filter === null || typeof filter !== "object") {
      throw new TypeError('waitFor(): the filter must be an object such as { to: "off" }');
    }
    for (const key of Object.keys(filter)) {
      if (!FILTER_KEYS.has(key)) throw new TypeError(`waitFor(): unknown filter option "${key}"`);
    }
    const timeoutMs =
      options.timeout === undefined
        ? undefined
        : parseDuration(options.timeout, "waitFor() timeout");
    const holdMs =
      options.for === undefined ? undefined : parseDuration(options.for, "waitFor() for");
    const { signal } = requireRun("waitFor");

    const trigger: StateTrigger = { kind: "state", entities: [entity], ...filter };
    const matcher = new StateMatcher(trigger, client.states);

    return new Promise<HaState | undefined>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      let cancelHold: (() => void) | undefined;
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        cancelHold?.();
        for (const cleanup of cleanups.splice(0)) cleanup();
        fn();
      };

      if (signal.aborted) return reject(signal.reason);
      const onAbort = (): void => finish(() => reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));

      if (timeoutMs !== undefined) {
        cleanups.push(clock.setTimeout(() => finish(() => resolve(undefined)), timeoutMs));
      }

      const hold = (state: HaState, since: number): void => {
        cancelHold?.();
        cancelHold = undefined;
        if (holdMs === undefined) return finish(() => resolve(state));
        const remaining = since + holdMs - clock.now();
        if (remaining <= 0) return finish(() => resolve(state));
        cancelHold = clock.setTimeout(() => finish(() => resolve(state)), remaining);
      };

      // Already matching (only meaningful without a from filter): counts from its timestamp.
      const current = client.states.get(entity);
      if (current && filter.from === undefined && matcher.matchesCurrent(current)) {
        const stamp = filter.attribute !== undefined ? current.last_updated : current.last_changed;
        hold(current, Date.parse(stamp));
        if (done) return;
      }

      const watching = client.dispatcher.watch([entity], (change) => {
        const verdict = matcher.evaluate(change);
        if (verdict.kind === "ignore") return;
        if (verdict.kind === "match" && change.newState) {
          hold(
            change.newState,
            change.resynced ? Date.parse(change.newState.last_changed) : clock.now(),
          );
        } else {
          cancelHold?.();
          cancelHold = undefined;
        }
      });
      cleanups.push(() => watching.dispose());
    });
  };
}
