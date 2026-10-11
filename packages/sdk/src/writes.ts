// Writes to Home Assistant. They may be awaited; if not, a failure is logged for the rule.

import type { EntityId, ServiceData, ServiceName, ServiceTarget } from "./entities.js";
import type { Handle } from "./rules.js";
import { notInEngine } from "./stub.js";

export interface CallOptions {
  /** Request response data (e.g. weather.get_forecasts) and resolve with it. */
  returnResponse?: boolean;
}

/**
 * Calls a Home Assistant service. Resolves when Home Assistant acknowledged the call (with the
 * response data when `returnResponse` is set); rejects with Home Assistant's error, or at once
 * when not connected.
 */
export function call<S extends ServiceName>(
  service: S,
  data?: ServiceData<S>,
  target?: ServiceTarget,
  options?: CallOptions,
): Promise<unknown>;
export function call(): Promise<unknown> {
  return notInEngine("call");
}

/** Turns an entity on unless it already is (then nothing is sent). */
export function on(entity: EntityId, data?: Record<string, unknown>): Promise<void>;
export function on(): Promise<void> {
  return notInEngine("on");
}

/** Turns an entity off unless it already is (then nothing is sent). */
export function off(entity: EntityId, data?: Record<string, unknown>): Promise<void>;
export function off(): Promise<void> {
  return notInEngine("off");
}

/** Always sends turn_on, e.g. to change attributes of a light that is already on. */
export function forceOn(entity: EntityId, data?: Record<string, unknown>): Promise<void>;
export function forceOn(): Promise<void> {
  return notInEngine("forceOn");
}

/** Always sends turn_off. */
export function forceOff(entity: EntityId, data?: Record<string, unknown>): Promise<void>;
export function forceOff(): Promise<void> {
  return notInEngine("forceOff");
}

/** Toggles an entity. */
export function toggle(entity: EntityId): Promise<void>;
export function toggle(): Promise<void> {
  return notInEngine("toggle");
}

/** Opens a cover to `position` (default 100 = open) unless it is already at least that open. */
export function up(cover: EntityId, position?: number): Promise<void>;
export function up(): Promise<void> {
  return notInEngine("up");
}

/** Closes a cover to `position` (default 0 = closed) unless it is already at most that open. */
export function down(cover: EntityId, position?: number): Promise<void>;
export function down(): Promise<void> {
  return notInEngine("down");
}

/** Fires a custom event on Home Assistant's event bus. */
export function fire(eventType: string, data?: Record<string, unknown>): Promise<void>;
export function fire(): Promise<void> {
  return notInEngine("fire");
}

/**
 * Creates or updates a virtual entity in Home Assistant's state machine, e.g.
 * `setState("sensor.living_room_comfort", "good", { friendly_name: "Comfort" })`.
 * Home Assistant forgets such entities when it restarts; the engine publishes the last value
 * again after reconnecting, as long as the rule that set it is loaded. Values are not kept
 * across engine restarts: set them from `onStartup` (e.g. from `store`) if needed at boot.
 */
export function setState(
  entity: string,
  state: string | number | boolean,
  attributes?: Record<string, unknown>,
): Promise<void>;
export function setState(): Promise<void> {
  return notInEngine("setState");
}

/** Raw WebSocket access for features the engine does not wrap (e.g. registries). */
export const ws: {
  command<T = unknown>(message: { type: string; [key: string]: unknown }): Promise<T>;
} = {
  command: () => notInEngine("ws.command"),
};

/** Connection status and notifications. Callbacks are released when the rule is unloaded. */
export const connection: {
  isConnected(): boolean;
  onConnect(callback: () => void | Promise<void>): Handle;
  onDisconnect(callback: () => void | Promise<void>): Handle;
} = {
  isConnected: () => notInEngine("connection.isConnected"),
  onConnect: () => notInEngine("connection.onConnect"),
  onDisconnect: () => notInEngine("connection.onDisconnect"),
};
