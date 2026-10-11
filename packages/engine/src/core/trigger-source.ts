// How the core arms trigger descriptors without knowing backends: each trigger kind has a
// source (the backend adapter provides state/event/ha-trigger sources, the scheduler the
// time and sun sources). A source arms one trigger for one rule and reports firings.

import type { RuleEvent, Trigger } from "@home-engine/sdk";
import type { Disposable } from "./adapter.js";
import type { RuleScope } from "./rule-scope.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event without the fields the core adds (the firing trigger and the run's signal). */
export type EventPayload = DistributiveOmit<RuleEvent, "trigger" | "signal">;

export interface ArmContext {
  scope: RuleScope;
  /** Reports one firing of the trigger. */
  fire(payload: EventPayload): void;
}

/** Arms `trigger`; the returned disposable disarms it. */
export type TriggerSource = (trigger: Trigger, context: ArmContext) => Disposable;

export type TriggerSources = Partial<Record<Trigger["kind"], TriggerSource>>;
