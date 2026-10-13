// Writes to Home Assistant. They may be awaited; if not, a failure is logged for the rule.

import type { EntityId, ServiceData, ServiceName, ServiceTarget } from "./entities.js";
import type { Handle } from "./rules.js";
import { notInEngine } from "./stub.js";

/**
 * Options of {@link call}.
 * @category Service calls & writes
 */
export interface CallOptions {
  /** Request response data (e.g. weather.get_forecasts) and resolve with it. */
  returnResponse?: boolean;
}

/**
 * Calls a Home Assistant service. Resolves when Home Assistant acknowledged the call (with the
 * response data when `returnResponse` is set); rejects with Home Assistant's error, or at once
 * when not connected.
 * @category Service calls & writes
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

/**
 * Turns an entity on unless it already is (then nothing is sent).
 * @category Service calls & writes
 */
export function on(entity: EntityId, data?: Record<string, unknown>): Promise<void>;
export function on(): Promise<void> {
  return notInEngine("on");
}

/**
 * Turns an entity off unless it already is (then nothing is sent).
 * @category Service calls & writes
 */
export function off(entity: EntityId, data?: Record<string, unknown>): Promise<void>;
export function off(): Promise<void> {
  return notInEngine("off");
}

/**
 * Always sends turn_on, e.g. to change attributes of a light that is already on.
 * @category Service calls & writes
 */
export function forceOn(entity: EntityId, data?: Record<string, unknown>): Promise<void>;
export function forceOn(): Promise<void> {
  return notInEngine("forceOn");
}

/**
 * Always sends turn_off.
 * @category Service calls & writes
 */
export function forceOff(entity: EntityId, data?: Record<string, unknown>): Promise<void>;
export function forceOff(): Promise<void> {
  return notInEngine("forceOff");
}

/**
 * Toggles an entity.
 * @category Service calls & writes
 */
export function toggle(entity: EntityId): Promise<void>;
export function toggle(): Promise<void> {
  return notInEngine("toggle");
}

/**
 * Opens a cover to `position` (default 100 = open) unless it is already at least that open.
 * @category Service calls & writes
 */
export function up(cover: EntityId, position?: number): Promise<void>;
export function up(): Promise<void> {
  return notInEngine("up");
}

/**
 * Closes a cover to `position` (default 0 = closed) unless it is already at most that open.
 * @category Service calls & writes
 */
export function down(cover: EntityId, position?: number): Promise<void>;
export function down(): Promise<void> {
  return notInEngine("down");
}

/**
 * Fires a custom event on Home Assistant's event bus.
 * @category Service calls & writes
 */
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
 * @category Service calls & writes
 */
export function setState(
  entity: string,
  state: string | number | boolean,
  attributes?: Record<string, unknown>,
): Promise<void>;
export function setState(): Promise<void> {
  return notInEngine("setState");
}

/**
 * Raw WebSocket access for features the engine does not wrap (e.g. registries).
 * @category Service calls & writes
 */
export const ws: {
  /**
   * Sends one WebSocket command (the message needs a `type`) and resolves with its result.
   * Rejects with Home Assistant's error, or at once when not connected.
   */
  command<T = unknown>(message: { type: string; [key: string]: unknown }): Promise<T>;
} = {
  command: () => notInEngine("ws.command"),
};

/**
 * Connection status and notifications. Callbacks are released when the rule is unloaded.
 * @category Service calls & writes
 */
export const connection: {
  /** Whether the engine is connected to Home Assistant and ready. */
  isConnected(): boolean;
  /** Calls `callback` each time the connection comes back. */
  onConnect(callback: () => unknown): Handle;
  /** Calls `callback` each time the connection is lost. */
  onDisconnect(callback: () => unknown): Handle;
} = {
  isConnected: () => notInEngine("connection.isConnected"),
  onConnect: () => notInEngine("connection.onConnect"),
  onDisconnect: () => notInEngine("connection.onDisconnect"),
};
