import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FiredHolds } from "./fired-holds.js";

const hold = {
  ruleId: "lights#hall",
  identity: "t0:abc",
  entityId: "light.hall",
  since: "2026-10-11T10:00:00.000Z",
};

describe("FiredHolds", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "he-fired-"));
    file = join(dir, "fired-holds.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("knows a recorded hold only for the same timestamp", () => {
    const record = new FiredHolds();
    record.record(hold);
    expect(record.has(hold)).toBe(true);
    expect(record.has({ ...hold, since: "2026-10-11T11:00:00.000Z" })).toBe(false);
  });

  it("keeps one entry per rule, trigger and entity, and forgets it when the entity changes", () => {
    const record = new FiredHolds();
    record.record(hold);
    record.record({ ...hold, since: "2026-10-11T11:00:00.000Z" });
    expect(record.all()).toHaveLength(1);
    record.forget(hold.ruleId, hold.identity, hold.entityId);
    expect(record.all()).toEqual([]);
  });

  it("prunes entries of rules that no longer exist", () => {
    const record = new FiredHolds();
    record.record(hold);
    record.record({ ...hold, ruleId: "gone#rule" });
    record.pruneRules(new Set(["lights#hall"]));
    expect(record.all().map((h) => h.ruleId)).toEqual(["lights#hall"]);
  });

  it("persists to its file and loads it again", async () => {
    const first = new FiredHolds(file);
    first.record(hold);
    await first.flush();
    const second = new FiredHolds(file);
    await second.load();
    expect(second.has(hold)).toBe(true);
  });

  it("starts empty when the file is corrupt", async () => {
    writeFileSync(file, "{ not json");
    const record = new FiredHolds(file);
    await record.load();
    expect(record.all()).toEqual([]);
  });
});
