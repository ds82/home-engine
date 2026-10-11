// Engine-level registry of Home Assistant subscriptions (design D5). Rules never talk to
// the socket directly: all handlers of an event type share one `subscribe_events`
// subscription (ref-counted; `state_changed` is just the busiest type), and each native
// trigger registration gets its own `subscribe_trigger`. After a reconnect, `attach()`
// replays everything onto the new session.

import type { Disposable } from "../../core/adapter.js";
import type { Logger } from "../../core/logger.js";
import type { HaSession } from "./session.js";

export interface HaEvent {
  event_type: string;
  data: Record<string, unknown>;
  origin: string;
  time_fired: string;
  context: { id: string; parent_id: string | null; user_id: string | null };
}

export type EventHandler = (event: HaEvent) => void;
export type TriggerHandler = (variables: Record<string, unknown>) => void;

/** Where an entry is currently subscribed. */
interface Binding {
  session: HaSession;
  id: number;
}

interface EventTypeEntry {
  eventType: string;
  handlers: Set<EventHandler>;
  binding: Binding | undefined;
  /** In-flight subscribe on this session, to avoid subscribing twice. */
  pending: HaSession | undefined;
}

interface TriggerEntry {
  trigger: unknown;
  handler: TriggerHandler;
  onError: (err: Error) => void;
  binding: Binding | undefined;
  pending: HaSession | undefined;
  disposed: boolean;
}

export class SubscriptionRegistry {
  private session: HaSession | undefined;
  private readonly eventTypes = new Map<string, EventTypeEntry>();
  private readonly triggers = new Set<TriggerEntry>();

  constructor(private readonly log: Logger) {}

  /** Number of Home Assistant subscriptions the registry wants (for status output). */
  get size(): number {
    return this.eventTypes.size + this.triggers.size;
  }

  /** Calls `handler` for every bus event of `eventType`. */
  onEvent(eventType: string, handler: EventHandler): Disposable {
    let entry = this.eventTypes.get(eventType);
    if (!entry) {
      entry = { eventType, handlers: new Set(), binding: undefined, pending: undefined };
      this.eventTypes.set(eventType, entry);
    }
    entry.handlers.add(handler);
    void this.bindEventType(entry);
    const e = entry;
    return {
      dispose: () => {
        if (!e.handlers.delete(handler) || e.handlers.size > 0) return;
        this.eventTypes.delete(eventType);
        this.release(e.binding);
        e.binding = undefined;
      },
    };
  }

  /** Calls `handler` for every `state_changed` event (one shared subscription). */
  onStateChanged(handler: EventHandler): Disposable {
    return this.onEvent("state_changed", handler);
  }

  /**
   * Subscribes a native Home Assistant trigger. `onError` is called whenever Home
   * Assistant rejects the configuration (on first subscribe or on replay).
   */
  onTrigger(trigger: unknown, handler: TriggerHandler, onError: (err: Error) => void): Disposable {
    const entry: TriggerEntry = {
      trigger,
      handler,
      onError,
      binding: undefined,
      pending: undefined,
      disposed: false,
    };
    this.triggers.add(entry);
    void this.bindTrigger(entry);
    return {
      dispose: () => {
        if (entry.disposed) return;
        entry.disposed = true;
        this.triggers.delete(entry);
        this.release(entry.binding);
        entry.binding = undefined;
      },
    };
  }

  /**
   * Makes `session` the current one and (re)subscribes every registration on it.
   * Resolves once all subscriptions were answered (accepted or rejected).
   */
  async attach(session: HaSession): Promise<void> {
    this.session = session;
    session.onClose(() => {
      if (this.session === session) this.session = undefined;
    });
    await Promise.all([
      ...[...this.eventTypes.values()].map((e) => this.bindEventType(e)),
      ...[...this.triggers].map((t) => this.bindTrigger(t)),
    ]);
  }

  private async bindEventType(entry: EventTypeEntry): Promise<void> {
    const session = this.session;
    if (!session?.isOpen || entry.binding?.session === session || entry.pending === session) {
      return;
    }
    entry.pending = session;
    try {
      const id = await session.subscribe(
        { type: "subscribe_events", event_type: entry.eventType },
        (event) => this.dispatchEvent(entry, event as HaEvent),
      );
      if (this.eventTypes.get(entry.eventType) !== entry) {
        // All handlers went away while subscribing.
        this.release({ session, id });
        return;
      }
      entry.binding = { session, id };
    } catch (err) {
      if (session.isOpen) {
        this.log.error({ err, eventType: entry.eventType }, "Subscribing to events failed");
      }
    } finally {
      if (entry.pending === session) entry.pending = undefined;
    }
  }

  private async bindTrigger(entry: TriggerEntry): Promise<void> {
    const session = this.session;
    if (
      entry.disposed ||
      !session?.isOpen ||
      entry.binding?.session === session ||
      entry.pending === session
    ) {
      return;
    }
    entry.pending = session;
    try {
      const id = await session.subscribe(
        { type: "subscribe_trigger", trigger: entry.trigger },
        (event) => this.dispatchTrigger(entry, event),
      );
      if (entry.disposed) {
        this.release({ session, id });
        return;
      }
      entry.binding = { session, id };
    } catch (err) {
      if (session.isOpen && !entry.disposed) entry.onError(err as Error);
    } finally {
      if (entry.pending === session) entry.pending = undefined;
    }
  }

  private dispatchEvent(entry: EventTypeEntry, event: HaEvent): void {
    for (const handler of [...entry.handlers]) {
      try {
        handler(event);
      } catch (err) {
        this.log.error({ err, eventType: entry.eventType }, "Event handler threw");
      }
    }
  }

  private dispatchTrigger(entry: TriggerEntry, event: unknown): void {
    if (entry.disposed) return;
    const variables = ((event as { variables?: Record<string, unknown> }).variables ??
      {}) as Record<string, unknown>;
    try {
      entry.handler(variables);
    } catch (err) {
      this.log.error({ err }, "Trigger handler threw");
    }
  }

  /** Ends a subscription on its session, if that session is still open. */
  private release(binding: Binding | undefined): void {
    if (!binding?.session.isOpen) return;
    binding.session.unsubscribe(binding.id).catch((err: unknown) => {
      this.log.debug({ err }, "Unsubscribing failed");
    });
  }
}
