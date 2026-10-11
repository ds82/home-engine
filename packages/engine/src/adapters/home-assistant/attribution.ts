// Change cause (rule-triggers: Change cause; design D5). A state change is "engine"-caused
// when its context's user is the engine's own user, i.e. a write of this engine made it
// directly; anything else (devices, people, Home Assistant automations, even ones reacting to
// an engine write) is "external". Every write's result carries the context Home Assistant
// created for it; remembering context ID → rule ID names the causing rule. parent_id is
// deliberately ignored.
//
// Home Assistant can send the resulting state_changed before the write's result. Such an
// event (engine user, unknown context, writes in flight) is held until the writes settled,
// at most MAX_HOLD_MS, then resolved with whatever is known.

import type { HaSession } from "./session.js";
import type { ChangeCause } from "./state-triggers.js";
import type { HaContext } from "./types.js";

/** How long a write's context stays attributable to its rule. */
export const CONTEXT_TTL_MS = 10_000;
/** Longest an engine-caused event waits for in-flight writes. */
export const MAX_HOLD_MS = 1_000;

export interface AttributionOptions {
  /** The engine's Home Assistant user ID (from auth/current_user). */
  engineUserId: () => string | undefined;
  maxHoldMs?: number;
  now?: () => number;
}

export class WriteAttribution {
  private readonly contexts = new Map<string, { ruleId: string; at: number }>();
  private inFlight = 0;
  private settledWaiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly options: AttributionOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Runs one write on behalf of `ruleId`. `write` resolves with the result Home Assistant
   * returned; its `context.id` is remembered for attribution.
   */
  async track<T extends { context?: HaContext } | null | undefined>(
    ruleId: string,
    write: () => Promise<T>,
  ): Promise<T> {
    this.inFlight++;
    try {
      const result = await write();
      const id = result?.context?.id;
      if (id) this.remember(id, ruleId);
      return result;
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.settledWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  /** The cause of a change, possibly after waiting for in-flight writes. */
  resolve(context: HaContext | undefined): ChangeCause | Promise<ChangeCause> {
    const engineUser = this.options.engineUserId();
    if (!context || !engineUser || context.user_id !== engineUser) return { causedBy: "external" };
    const known = this.lookup(context.id);
    if (known || this.inFlight === 0) return known ?? { causedBy: "engine" };

    // The event overtook its write's result: wait for in-flight writes (bounded).
    return new Promise<ChangeCause>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve(this.lookup(context.id) ?? { causedBy: "engine" });
      };
      const timer = setTimeout(done, this.options.maxHoldMs ?? MAX_HOLD_MS);
      this.settledWaiters.push(done);
    });
  }

  private lookup(contextId: string): ChangeCause | undefined {
    const entry = this.contexts.get(contextId);
    if (!entry || this.now() - entry.at > CONTEXT_TTL_MS) return undefined;
    return { causedBy: "engine", causedByRule: entry.ruleId };
  }

  private remember(contextId: string, ruleId: string): void {
    const now = this.now();
    for (const [id, entry] of this.contexts) {
      if (now - entry.at > CONTEXT_TTL_MS) this.contexts.delete(id);
    }
    this.contexts.set(contextId, { ruleId, at: now });
  }
}

/**
 * A service call attributed to a rule. The write layer (on/off/call/...) builds on this;
 * it resolves with Home Assistant's result (context and optional response).
 */
export function trackedServiceCall(
  attribution: WriteAttribution,
  session: HaSession,
  ruleId: string,
  call: {
    domain: string;
    service: string;
    service_data?: Record<string, unknown>;
    target?: Record<string, unknown>;
  },
): Promise<{ context: HaContext; response?: unknown }> {
  return attribution.track(ruleId, () =>
    session.command<{ context: HaContext; response?: unknown }>({ type: "call_service", ...call }),
  );
}
