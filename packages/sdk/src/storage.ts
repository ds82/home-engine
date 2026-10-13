// Persistent key/value stores. Values must be plain JSON data and survive reloads, engine
// restarts and container re-creation (as long as the data volume is kept).

import { notInEngine } from "./stub.js";

/**
 * A persistent key/value store of plain JSON data: {@link store} or {@link shared}.
 * @category Storage
 */
export interface KeyValueStore {
  /** The stored value (a copy), or undefined. */
  get<T = unknown>(key: string): T | undefined;
  /** Stores plain JSON data; throws for functions, Dates, cycles and the like. */
  set(key: string, value: unknown): void;
  /** Removes a key; true if it existed. */
  delete(key: string): boolean;
  /** All keys currently stored. */
  keys(): string[];
}

const stub = (name: string): KeyValueStore => ({
  get: () => notInEngine(`${name}.get`),
  set: () => notInEngine(`${name}.set`),
  delete: () => notInEngine(`${name}.delete`),
  keys: () => notInEngine(`${name}.keys`),
});

/**
 * The calling rule's own store; other rules cannot see its keys.
 * @category Storage
 */
export const store: KeyValueStore = stub("store");

/**
 * A store all rules read and write, for intentional coordination between rules.
 * @category Storage
 */
export const shared: KeyValueStore = stub("shared");
