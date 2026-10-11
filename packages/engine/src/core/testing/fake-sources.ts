// Fake trigger sources for core tests: they record what is armed and let the test fire it.

import type { Trigger } from "@home-engine/sdk";
import type { ArmContext, EventPayload, TriggerSources } from "../trigger-source.js";

interface Armed {
  trigger: Trigger;
  context: ArmContext;
}

export class FakeSources {
  private readonly armed = new Set<Armed>();

  readonly sources: TriggerSources = {
    state: (t, c) => this.arm(t, c),
    event: (t, c) => this.arm(t, c),
    cron: (t, c) => this.arm(t, c),
  };

  /** Number of currently armed triggers. */
  get count(): number {
    return this.armed.size;
  }

  /** Fires every armed trigger matching `match`; returns how many fired. */
  fire(match: (t: Trigger) => boolean, payload: EventPayload): number {
    let n = 0;
    for (const a of [...this.armed]) {
      if (match(a.trigger)) {
        a.context.fire(payload);
        n++;
      }
    }
    return n;
  }

  /** Fires state triggers watching `entityId` with a simple change payload. */
  change(entityId: string, to = "on"): number {
    return this.fire((t) => t.kind === "state" && t.entities.includes(entityId), {
      type: "state",
      entityId,
      from: undefined,
      to: {
        entity_id: entityId,
        state: to,
        attributes: {},
        last_changed: "",
        last_updated: "",
        context: { id: "c", parent_id: null, user_id: null },
      },
      causedBy: "external",
      causedByEngine: false,
      resynced: false,
      restored: false,
    });
  }

  private arm(trigger: Trigger, context: ArmContext) {
    const entry = { trigger, context };
    this.armed.add(entry);
    return { dispose: () => void this.armed.delete(entry) };
  }
}
