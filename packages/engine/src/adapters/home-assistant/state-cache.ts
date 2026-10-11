// The local cache of all entity states (ha-connection spec: Local state cache). Rules read
// it synchronously. It is rebuilt from `get_states` on every connect and kept current from
// `state_changed` events. After a reconnect, the differences between the old and the new
// snapshot are reported as resynced changes (rule-triggers: Synthetic events after resync).

import type { Disposable } from "../../core/adapter.js";
import type { Logger } from "../../core/logger.js";
import type { HaSession } from "./session.js";
import type { HaEvent, SubscriptionRegistry } from "./subscriptions.js";
import type { HaState } from "./types.js";

export interface StateChange {
  entityId: string;
  /** Undefined when the entity was created. */
  oldState: HaState | undefined;
  /** Undefined when the entity was removed. */
  newState: HaState | undefined;
  /** True for changes synthesised after a reconnect. */
  resynced: boolean;
  /** Context of the `state_changed` event (undefined for resynced changes). */
  context: HaEvent["context"] | undefined;
  /** Who caused it; set by the dispatcher before triggers see the change. */
  cause?: { causedBy: "engine" | "external"; causedByRule?: string };
}

export type StateChangeListener = (change: StateChange) => void;

export class StateCache {
  private states = new Map<string, HaState>();
  private readonly listeners = new Set<StateChangeListener>();
  /** Live events received while a sync is in progress; applied after the swap. */
  private buffer: HaEvent[] | undefined;
  private synced = false;
  private readonly subscription: Disposable;

  constructor(
    registry: SubscriptionRegistry,
    private readonly log: Logger,
  ) {
    this.subscription = registry.onStateChanged((event) => this.onStateChanged(event));
  }

  get(entityId: string): HaState | undefined {
    return this.states.get(entityId);
  }

  all(): HaState[] {
    return [...this.states.values()];
  }

  get size(): number {
    return this.states.size;
  }

  onChange(listener: StateChangeListener): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * Loads the full state list from `session` and swaps it in atomically. On every sync but
   * the first, reports the differences to the previous cache as resynced changes.
   */
  async sync(session: HaSession): Promise<void> {
    this.buffer = [];
    let fresh: HaState[];
    try {
      fresh = await session.command<HaState[]>({ type: "get_states" });
    } catch (err) {
      this.buffer = undefined;
      throw err;
    }
    const buffered = this.buffer;
    this.buffer = undefined;

    const previous = this.states;
    const next = new Map(fresh.map((s) => [s.entity_id, s]));
    this.states = next;

    if (this.synced) {
      const changes = diff(previous, next);
      this.log.debug(
        { differed: changes.length, entities: next.size },
        `Resync after reconnect: ${changes.length} entities differed`,
      );
      for (const change of changes) this.emit(change);
    }
    this.synced = true;

    // Events that raced with get_states: apply those newer than the snapshot.
    for (const event of buffered) this.onStateChanged(event, next);
  }

  dispose(): void {
    this.subscription.dispose();
    this.listeners.clear();
  }

  private onStateChanged(event: HaEvent, snapshot?: Map<string, HaState>): void {
    if (this.buffer) {
      this.buffer.push(event);
      return;
    }
    const data = event.data as {
      entity_id: string;
      old_state: HaState | null;
      new_state: HaState | null;
    };
    const entityId = data.entity_id;
    const current = this.states.get(entityId);
    const newState = data.new_state ?? undefined;

    if (snapshot) {
      // Replaying a buffered event: skip it if the snapshot already reflects it.
      const snap = snapshot.get(entityId);
      if (newState && snap && snap.last_updated >= newState.last_updated) return;
      if (!newState && !snap) return;
    }

    if (newState) this.states.set(entityId, newState);
    else this.states.delete(entityId);
    this.emit({
      entityId,
      oldState: current ?? data.old_state ?? undefined,
      newState,
      resynced: false,
      context: event.context,
    });
  }

  private emit(change: StateChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (err) {
        this.log.error({ err, entityId: change.entityId }, "State change listener threw");
      }
    }
  }
}

/** Changes between two snapshots: entities whose state or attributes differ, appeared or vanished. */
function diff(before: Map<string, HaState>, after: Map<string, HaState>): StateChange[] {
  const changes: StateChange[] = [];
  for (const [entityId, newState] of after) {
    const oldState = before.get(entityId);
    if (
      oldState &&
      oldState.state === newState.state &&
      deepEqual(oldState.attributes, newState.attributes)
    ) {
      continue;
    }
    changes.push({ entityId, oldState, newState, resynced: true, context: undefined });
  }
  for (const [entityId, oldState] of before) {
    if (!after.has(entityId)) {
      changes.push({ entityId, oldState, newState: undefined, resynced: true, context: undefined });
    }
  }
  return changes;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
