// Home Assistant trigger constructors (rule-triggers: Trigger constructors). They validate
// their arguments eagerly, so a typo fails at the call site while the file loads, and return
// frozen descriptors without subscribing anything.

import type {
  EventDataFilter,
  EventTrigger,
  HaTrigger,
  HaTriggerConfig,
  StateTrigger,
  StateTriggerOptions,
} from "@home-engine/sdk";
import { parseDuration } from "../../core/duration.js";
import { deepFreeze } from "../../core/freeze.js";

/** `domain.object_id`, where both parts may contain `*` globs. */
const ENTITY_SELECTOR = /^[a-z0-9_*]+\.[a-z0-9_*]+$/i;

const STATE_OPTIONS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "attribute",
  "for",
  "holdAs",
  "immediate",
  "ignoreUnavailable",
]);

/** SDK `onChange(entities, options?)`. */
export function onChange(entities: unknown, options: unknown = {}): StateTrigger {
  const list = Array.isArray(entities) ? [...(entities as unknown[])] : [entities];
  if (list.length === 0) {
    throw new TypeError("onChange(): at least one entity is required");
  }
  for (const entity of list) {
    if (typeof entity !== "string" || !ENTITY_SELECTOR.test(entity)) {
      throw new TypeError(
        `onChange(): ${JSON.stringify(entity)} is not an entity ID or pattern (e.g. "light.kitchen" or "light.*")`,
      );
    }
  }

  if (!isPlainObject(options)) {
    throw new TypeError("onChange(): options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!STATE_OPTIONS.has(key)) {
      throw new TypeError(
        `onChange(): unknown option "${key}" (allowed: ${[...STATE_OPTIONS].join(", ")})`,
      );
    }
  }
  const o = options as StateTriggerOptions;
  if (o.from !== undefined) {
    checkFilter("from", o.from);
  }
  if (o.to !== undefined) {
    checkFilter("to", o.to);
  }
  if (o.attribute !== undefined && (typeof o.attribute !== "string" || o.attribute === "")) {
    throw new TypeError("onChange(): attribute must be a non-empty string");
  }
  if (o.for !== undefined) {
    parseDuration(o.for, "onChange() for");
  }
  if (o.holdAs !== undefined) {
    if (o.holdAs !== "entity" && o.holdAs !== "group") {
      throw new TypeError('onChange(): holdAs must be "entity" or "group"');
    }
    if (o.for === undefined) {
      throw new TypeError("onChange(): holdAs only applies together with for");
    }
  }
  for (const flag of ["immediate", "ignoreUnavailable"] as const) {
    if (o[flag] !== undefined && typeof o[flag] !== "boolean") {
      throw new TypeError(`onChange(): ${flag} must be true or false`);
    }
  }
  if (o.immediate && (o.for !== undefined || o.from !== undefined)) {
    throw new TypeError(
      "onChange(): immediate cannot be combined with for (held states are restored on start anyway) or with from (there is no previous state to check)",
    );
  }

  return deepFreeze({
    kind: "state",
    entities: list as string[],
    ...copyArrays(o),
  }) as StateTrigger;
}

/** SDK `onEvent(eventType, dataFilter?)`. */
export function onEvent(eventType: unknown, dataFilter?: unknown): EventTrigger {
  if (typeof eventType !== "string" || eventType.trim() === "") {
    throw new TypeError("onEvent(): the event type must be a non-empty string");
  }
  if (dataFilter !== undefined && typeof dataFilter !== "function" && !isPlainObject(dataFilter)) {
    throw new TypeError("onEvent(): the data filter must be an object or a function");
  }
  const descriptor: { kind: "event"; eventType: string; dataFilter?: EventDataFilter } = {
    kind: "event",
    eventType,
  };
  if (dataFilter !== undefined) {
    descriptor.dataFilter = copyPlain(dataFilter as EventDataFilter);
  }
  return deepFreeze(descriptor);
}

/** SDK `onTrigger(config)`: a native Home Assistant trigger configuration. */
export function onTrigger(config: unknown): HaTrigger {
  if (!isPlainObject(config)) {
    throw new TypeError("onTrigger(): the trigger configuration must be an object");
  }
  const platform = (config as HaTriggerConfig).platform ?? (config as HaTriggerConfig).trigger;
  if (typeof platform !== "string" || platform === "") {
    throw new TypeError(
      'onTrigger(): the configuration needs a "platform" (or "trigger"), e.g. "numeric_state"',
    );
  }
  return deepFreeze({
    kind: "ha-trigger",
    config: copyPlain(config) as HaTriggerConfig,
  });
}

function checkFilter(name: string, filter: unknown): void {
  const ok = (v: unknown): boolean =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  if (typeof filter === "function" || ok(filter)) {
    return;
  }
  if (Array.isArray(filter) && filter.length > 0 && filter.every(ok)) {
    return;
  }
  throw new TypeError(
    `onChange(): ${name} must be a value, a non-empty array of values or a function`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Copies arrays in the options so freezing never touches the caller's arrays. */
function copyArrays<T extends object>(options: T): T {
  return Object.fromEntries(
    Object.entries(options).map(([k, v]) => [k, Array.isArray(v) ? [...(v as unknown[])] : v]),
  ) as T;
}

/** Copies plain objects and arrays (keeping functions) so the descriptor owns its data. */
function copyPlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(copyPlain) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyPlain(v)])) as T;
  }
  return value;
}
