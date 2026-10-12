// Synchronous state reads and predicates (ha-actions: Synchronous state reads, Numeric state
// helper, State predicates). They read the local state cache, never throw for unknown
// entities and work anywhere, including a rule file's top level.

import { globToRegex } from "./state-triggers.js";
import type { StateCache } from "./state-cache.js";
import type { HaState } from "./types.js";

const UNAVAILABLE = new Set(["unavailable", "unknown"]);

export interface StateHelpers {
  getState(entity: string): string | undefined;
  getEntity(entity: string): HaState | undefined;
  getEntities(patterns: string | readonly string[]): HaState[];
  members(group: string): string[];
  getNumber(entity: string, attribute?: string): number | undefined;
  is(entity: string, value: string | number | boolean): boolean;
  isOn(entity: string): boolean;
  isOff(entity: string): boolean;
  isOpen(entity: string): boolean;
  isClosed(entity: string): boolean;
}

export function createStateHelpers(cache: StateCache): StateHelpers {
  const available = (entity: string): HaState | undefined => {
    const state = cache.get(entity);
    return state && !UNAVAILABLE.has(state.state) ? state : undefined;
  };
  const isBinarySensor = (entity: string): boolean => entity.startsWith("binary_sensor.");

  return {
    getState: (entity) => cache.get(entity)?.state,
    getEntity: (entity) => cache.get(entity),
    getEntities: (patterns) => {
      const list = typeof patterns === "string" ? [patterns] : [...patterns];
      const regexes = list.map((p) => (p.includes("*") ? globToRegex(p) : undefined));
      return cache
        .all()
        .filter((s) =>
          list.some((p, i) => (regexes[i] ? regexes[i].test(s.entity_id) : p === s.entity_id)),
        )
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    },
    members: (group) => {
      const ids = cache.get(group)?.attributes.entity_id;
      if (Array.isArray(ids)) {
        return ids.filter((id): id is string => typeof id === "string");
      }
      return typeof ids === "string" ? [ids] : [];
    },
    getNumber: (entity, attribute) => {
      const state = cache.get(entity);
      if (!state) {
        return undefined;
      }
      const raw: unknown = attribute === undefined ? state.state : state.attributes[attribute];
      if (typeof raw === "number") {
        return Number.isFinite(raw) ? raw : undefined;
      }
      if (typeof raw !== "string" || raw.trim() === "" || UNAVAILABLE.has(raw)) {
        return undefined;
      }
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    },
    is: (entity, value) => available(entity)?.state === String(value),
    isOn: (entity) => available(entity)?.state === "on",
    isOff: (entity) => available(entity)?.state === "off",
    isOpen: (entity) => {
      const state = available(entity)?.state;
      return state === "open" || (isBinarySensor(entity) && state === "on");
    },
    isClosed: (entity) => {
      const state = available(entity)?.state;
      return state === "closed" || (isBinarySensor(entity) && state === "off");
    },
  };
}
