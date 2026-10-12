// Bus event and native trigger sources (rule-triggers: Event trigger, Native Home Assistant
// trigger), plus the set of all Home Assistant trigger sources for a client.

import type { EventDataFilter, Trigger } from "@home-engine/sdk";
import type { TriggerSource, TriggerSources } from "../../core/trigger-source.js";
import type { HaClient } from "./client.js";
import { matchesFilter, stateTriggerSource, type StateSourceOptions } from "./state-triggers.js";
import type { SubscriptionRegistry } from "./subscriptions.js";

/** `onEvent`: one shared subscription per event type; the data filter is applied locally. */
export function eventTriggerSource(registry: SubscriptionRegistry): TriggerSource {
  return (trigger: Trigger, context) => {
    if (trigger.kind !== "event") {
      throw new Error(`event source cannot arm ${trigger.kind}`);
    }
    return registry.onEvent(trigger.eventType, (event) => {
      if (!matchesData(trigger.dataFilter, event.data)) {
        return;
      }
      context.fire({
        type: "event",
        eventType: event.event_type,
        data: event.data,
        origin: event.origin,
        timeFired: new Date(event.time_fired),
        context: event.context,
      });
    });
  };
}

/** `onTrigger`: a native Home Assistant trigger with its own subscription. */
export function haTriggerSource(registry: SubscriptionRegistry): TriggerSource {
  return (trigger: Trigger, context) => {
    if (trigger.kind !== "ha-trigger") {
      throw new Error(`ha-trigger source cannot arm ${trigger.kind}`);
    }
    return registry.onTrigger(
      trigger.config,
      (variables) => context.fire({ type: "ha-trigger", variables }),
      (error) => context.reportError(error),
    );
  };
}

/** All trigger sources the Home Assistant adapter provides, bound to one client. */
export function homeAssistantTriggerSources(
  client: HaClient,
  options: Omit<StateSourceOptions, "dispatcher" | "cache" | "connection"> = {},
): TriggerSources {
  return {
    state: stateTriggerSource({
      ...options,
      dispatcher: client.dispatcher,
      cache: client.states,
      connection: { isReady: () => client.isReady, onReady: (l) => client.onReady(l) },
    }),
    event: eventTriggerSource(client.subscriptions),
    "ha-trigger": haTriggerSource(client.subscriptions),
  };
}

/**
 * Event data filter: a predicate on the whole data, or a partial object matched recursively.
 * Nested objects match partially; leaves are literals, arrays of allowed values or predicates.
 */
export function matchesData(filter: EventDataFilter | undefined, data: unknown): boolean {
  if (filter === undefined) {
    return true;
  }
  if (typeof filter === "function") {
    return filter(data as Record<string, unknown>);
  }
  return matchesPartial(filter, data);
}

function matchesPartial(filter: Record<string, unknown>, data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  return Object.entries(filter).every(([key, expected]) => {
    const actual = (data as Record<string, unknown>)[key];
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
      return matchesPartial(expected as Record<string, unknown>, actual);
    }
    return matchesFilter(expected as Parameters<typeof matchesFilter>[0], actual);
  });
}
