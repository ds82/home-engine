// Synchronous state reads and predicates; they read the engine's local state cache.

import type { EntityId, EntityOf, EntitySelector, HassEntity } from "./entities.js";
import { notInEngine } from "./stub.js";

/**
 * The entity's current state value, or undefined for unknown entities.
 * @category State
 */
export function getState(entity: EntityId): string | undefined;
export function getState(): undefined {
  return notInEngine("getState");
}

/**
 * The full state object (state, attributes, last_changed, ...), or undefined.
 * @category State
 */
export function getEntity<Id extends EntityId>(entity: Id): EntityOf<Id> | undefined;
export function getEntity(): undefined {
  return notInEngine("getEntity");
}

/**
 * State objects of all entities matching IDs or globs such as `light.*`.
 * @category State
 */
export function getEntities(patterns: EntitySelector | readonly EntitySelector[]): HassEntity[];
export function getEntities(): HassEntity[] {
  return notInEngine("getEntities");
}

/**
 * Entity IDs in a group's `entity_id` attribute; empty if the group does not exist.
 * @category State
 */
export function members(group: EntityId): string[];
export function members(): string[] {
  return notInEngine("members");
}

/**
 * The state (or an attribute) as a number; undefined if unknown, unavailable or not numeric.
 * @category State
 */
export function getNumber(entity: EntityId, attribute?: string): number | undefined;
export function getNumber(): undefined {
  return notInEngine("getNumber");
}

/**
 * True if the entity's state equals `value`; false for unknown or unavailable entities.
 * @category State
 */
export function is(entity: EntityId, value: string | number | boolean): boolean;
export function is(): boolean {
  return notInEngine("is");
}

/**
 * True if the state is `on`.
 * @category State
 */
export function isOn(entity: EntityId): boolean;
export function isOn(): boolean {
  return notInEngine("isOn");
}

/**
 * True if the state is `off`.
 * @category State
 */
export function isOff(entity: EntityId): boolean;
export function isOff(): boolean {
  return notInEngine("isOff");
}

/**
 * True for state `open`, or `on` on a binary_sensor.
 * @category State
 */
export function isOpen(entity: EntityId): boolean;
export function isOpen(): boolean {
  return notInEngine("isOpen");
}

/**
 * True for state `closed`, or `off` on a binary_sensor.
 * @category State
 */
export function isClosed(entity: EntityId): boolean;
export function isClosed(): boolean {
  return notInEngine("isClosed");
}
