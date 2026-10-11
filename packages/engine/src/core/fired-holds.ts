// The record of holds that already fired (rule-triggers: Hold restoration on rule start).
// Without it, a hold whose duration passed long ago (a door open for days) would fire again
// on every reload. Engine-internal state: its own file in the data directory, separate from
// rule storage, written atomically. One entry per rule, trigger identity and entity; it
// holds the state timestamp the fired hold counted from.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FiredHold {
  ruleId: string;
  /** Trigger identity (position or listener id, plus a hash of the description). */
  identity: string;
  entityId: string;
  /** `last_changed` (or `last_updated` for attribute triggers) the hold counted from. */
  since: string;
}

const keyOf = (h: Pick<FiredHold, "ruleId" | "identity" | "entityId">): string =>
  JSON.stringify([h.ruleId, h.identity, h.entityId]);

export class FiredHolds {
  private readonly entries = new Map<string, FiredHold>();
  private saving: Promise<void> = Promise.resolve();

  /** `file` is `<DATA_DIR>/fired-holds.json`; without it the record lives in memory only. */
  constructor(private readonly file?: string) {}

  async load(): Promise<void> {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as { holds?: FiredHold[] };
      for (const hold of data.holds ?? []) this.entries.set(keyOf(hold), hold);
    } catch {
      // A corrupt record only means a few holds may fire once more; start empty.
    }
  }

  /** True when this exact hold (same timestamp) already fired. */
  has(hold: FiredHold): boolean {
    return this.entries.get(keyOf(hold))?.since === hold.since;
  }

  /** Remembers a fired hold, replacing an older one for the same rule, trigger and entity. */
  record(hold: FiredHold): void {
    this.entries.set(keyOf(hold), { ...hold });
    this.save();
  }

  /** The entity changed: its fired hold no longer applies. */
  forget(ruleId: string, identity: string, entityId: string): void {
    if (this.entries.delete(keyOf({ ruleId, identity, entityId }))) this.save();
  }

  /** Drops entries of rules that no longer exist (after a full load). */
  pruneRules(existingRuleIds: ReadonlySet<string>): void {
    let changed = false;
    for (const [key, hold] of this.entries) {
      if (!existingRuleIds.has(hold.ruleId)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  all(): FiredHold[] {
    return [...this.entries.values()];
  }

  /** Resolves when all pending writes are on disk. */
  flush(): Promise<void> {
    return this.saving;
  }

  private save(): void {
    const file = this.file;
    if (!file) return;
    const snapshot = JSON.stringify({ version: 1, holds: this.all() }, null, 2);
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, file);
    });
  }
}
