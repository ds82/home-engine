// Stable identities for armed triggers, used to recognise a hold across reloads and
// restarts (rule-triggers: Hold restoration on rule start). An identity combines where the
// trigger sits (position in a rule's trigger list, the order of listen() calls during
// setup, or an explicit listener id) with a hash of its description, so editing a trigger
// makes it a new one.

import { createHash } from "node:crypto";
import type { Trigger } from "@home-engine/sdk";

/** Short hash of a trigger description; functions (predicates) count by their source. */
export function describeTrigger(trigger: Trigger): string {
  const text = JSON.stringify(trigger, (_key, value: unknown) =>
    typeof value === "function" ? `fn:${String(value)}` : sortKeys(value),
  );
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function triggerIdentity(position: string, trigger: Trigger): string {
  return `${position}:${describeTrigger(trigger)}`;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, (value as Record<string, unknown>)[k]]),
  );
}
