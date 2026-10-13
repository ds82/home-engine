import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleScopeImpl } from "./rule-scope.js";
import { invoke } from "./run-context.js";
import {
  checkJson,
  namespaceFile,
  Storage,
  storageSdk,
  syncDirectory,
  writeAtomically,
} from "./storage.js";
import { logCapture, type LogCapture } from "./testing/log-capture.js";

describe("rule storage", () => {
  let dir: string;
  let capture: LogCapture;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "home-engine-storage-")), "storage");
    capture = logCapture([]);
  });

  afterEach(() => {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  /** Runs `fn` as code of rule `ruleId`. */
  async function asRule<T>(ruleId: string, fn: () => T): Promise<T> {
    const scope = new RuleScopeImpl(ruleId, capture.log);
    let result: T | undefined;
    await invoke(scope, "body", () => {
      result = fn();
    }).done;
    await scope.dispose();
    return result as T;
  }

  const fileOf = (ns: string): string => join(dir, namespaceFile(ns));

  it("keeps each rule's values apart and shares the shared store", async () => {
    const { store, shared } = storageSdk(new Storage(dir, capture.log));
    await asRule("a#one", () => {
      store.set("count", 1);
      shared.set("vacation", true);
    });
    expect(await asRule("b#two", () => store.get("count"))).toBeUndefined();
    expect(await asRule("b#two", () => shared.get("vacation"))).toBe(true);
    expect(await asRule("a#one", () => [store.get("count"), store.keys()])).toEqual([1, ["count"]]);
    expect(await asRule("a#one", () => [store.delete("count"), store.delete("count")])).toEqual([
      true,
      false,
    ]);
  });

  it("rejects non-serialisable values and keeps the previous value", async () => {
    const { store } = storageSdk(new Storage(dir, capture.log));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const errors = await asRule("a#one", () => {
      store.set("config", { level: 1 });
      return [() => {}, circular, new Date(0), { nested: [1, Number.NaN] }, undefined].map(
        (value) => {
          try {
            store.set("config", value);
            return "stored";
          } catch (err) {
            return (err as Error).message;
          }
        },
      );
    });
    expect(errors).toEqual([
      expect.stringMatching(/value is a function/),
      expect.stringMatching(/value.self is a circular reference/),
      expect.stringMatching(/value is a Date \(store date.toISOString\(\) instead\)/),
      expect.stringMatching(/value.nested\[1\] is NaN/),
      expect.stringMatching(/value is undefined/),
    ]);
    expect(await asRule("a#one", () => store.get("config"))).toEqual({ level: 1 });
  });

  it("returns copies, so changing a read value does not change the store", async () => {
    const { store } = storageSdk(new Storage(dir, capture.log));
    await asRule("a#one", () => {
      const list = [1];
      store.set("list", list);
      list.push(2);
      store.get<number[]>("list")?.push(3);
    });
    expect(await asRule("a#one", () => store.get("list"))).toEqual([1]);
  });

  it("needs rule code for the per-rule store", () => {
    const { store } = storageSdk(new Storage(dir, capture.log));
    expect(() => store.get("x")).toThrow(/store.get\(\) must be called from rule code/);
  });

  it("persists values across a simulated restart, including the shared store", async () => {
    const before = new Storage(dir, capture.log);
    const sdk = storageSdk(before);
    await asRule("lights/hall.ts#motion", () => {
      sdk.store.set("lastRun", "2026-10-11T08:00:00Z");
      sdk.shared.set("vacation", true);
    });
    await before.flush();
    expect(JSON.parse(readFileSync(fileOf("lights/hall.ts#motion"), "utf8"))).toEqual({
      version: 1,
      values: { lastRun: "2026-10-11T08:00:00Z" },
    });

    const after = new Storage(dir, capture.log);
    await after.load();
    const restarted = storageSdk(after);
    expect(await asRule("lights/hall.ts#motion", () => restarted.store.get("lastRun"))).toBe(
      "2026-10-11T08:00:00Z",
    );
    expect(restarted.shared.get("vacation")).toBe(true);
  });

  it("keeps values across a reload and for removed rules", async () => {
    const storage = new Storage(dir, capture.log);
    const { store } = storageSdk(storage);
    await asRule("a#one", () => store.set("count", 3));
    // A reload creates a new scope for the same rule ID; nothing is deleted meanwhile.
    expect(await asRule("a#one", () => store.get("count"))).toBe(3);
    await storage.flush();
    expect(existsSync(fileOf("a#one"))).toBe(true);
  });

  it("flushes on its own shortly after a write, without leaving temp files", async () => {
    const storage = new Storage(dir, capture.log, { flushDelayMs: 20 });
    const { store } = storageSdk(storage);
    await asRule("a#one", () => store.set("count", 1));
    expect(existsSync(fileOf("a#one"))).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    await storage.flush();
    expect(JSON.parse(readFileSync(fileOf("a#one"), "utf8")).values).toEqual({ count: 1 });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes pending values when flushed on shutdown", async () => {
    const storage = new Storage(dir, capture.log, { flushDelayMs: 60_000 });
    const { store } = storageSdk(storage);
    await asRule("a#one", () => store.set("count", 2));
    await storage.flush();
    expect(JSON.parse(readFileSync(fileOf("a#one"), "utf8")).values).toEqual({ count: 2 });
  });

  it("moves a corrupted file aside, logs an error and starts empty", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileOf("a#one"), "{ not json");
    writeFileSync(fileOf("_shared"), JSON.stringify({ version: 1, values: { ok: 1 } }));
    const storage = new Storage(dir, capture.log, { now: () => Date.UTC(2026, 9, 11, 8) });
    await storage.load();
    const { store, shared } = storageSdk(storage);
    expect(await asRule("a#one", () => store.keys())).toEqual([]);
    expect(shared.get("ok")).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([
      "_shared.json",
      "a%23one.json.corrupt-2026-10-11T08-00-00-000Z",
    ]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        message:
          "Storage file a%23one.json is corrupted; moved it aside and starting with an empty store",
      }),
    );
  });

  it("retries a failed write with backoff and keeps the value", async () => {
    let attempts = 0;
    const storage = new Storage(dir, capture.log, {
      retryBaseMs: 10,
      io: {
        writeAtomically: async (file, text) => {
          if (++attempts <= 2) {
            throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
          }
          await writeAtomically(file, text);
        },
      },
    });
    storage.namespace("a#one").set("count", 3);
    await storage.flush();
    expect(existsSync(fileOf("a#one"))).toBe(false);
    await new Promise((r) => setTimeout(r, 60)); // retries after 10 ms and 20 ms
    expect(attempts).toBe(3);
    expect(JSON.parse(readFileSync(fileOf("a#one"), "utf8"))).toMatchObject({
      values: { count: 3 },
    });
    expect(
      capture.entries().filter((e) => e.message === "Writing a storage file failed; will retry"),
    ).toHaveLength(2);
    expect(storage.namespace("a#one").get("count")).toBe(3);
  });

  it("makes a final attempt for a failed write when flushed on shutdown", async () => {
    let fail = true;
    const storage = new Storage(dir, capture.log, {
      retryBaseMs: 60_000,
      io: {
        writeAtomically: async (file, text) => {
          if (fail) {
            throw new Error("read-only file system");
          }
          await writeAtomically(file, text);
        },
      },
    });
    storage.namespace("a#one").set("count", 1);
    await storage.flush();
    fail = false;
    await storage.flush(); // shutdown
    expect(JSON.parse(readFileSync(fileOf("a#one"), "utf8")).values).toEqual({ count: 1 });
  });

  it("syncs the storage directory after renaming a file into it", async () => {
    mkdirSync(dir, { recursive: true });
    const synced: Array<[string, boolean]> = [];
    await writeAtomically(fileOf("a#one"), "{}\n", async (d) => {
      synced.push([d, existsSync(fileOf("a#one"))]);
      await syncDirectory(d);
    });
    expect(synced).toEqual([[dir, true]]); // after the rename
    expect(readdirSync(dir)).toEqual([namespaceFile("a#one")]);
  });

  it("skips unexpected names and corrupt files that cannot be moved aside", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "%E0%A4%A.json"), "{}");
    writeFileSync(fileOf("a#one"), "{ not json");
    writeFileSync(fileOf("b#two"), JSON.stringify({ version: 1, values: { ok: true } }));
    const storage = new Storage(dir, capture.log, {
      io: {
        rename: () => Promise.reject(new Error("EACCES: permission denied")),
      },
    });
    await storage.load();
    expect(storage.namespace("b#two").get("ok")).toBe(true);
    expect(storage.namespace("a#one").keys()).toEqual([]);
    expect(readFileSync(fileOf("a#one"), "utf8")).toBe("{ not json"); // not overwritten
    const levels = capture.entries().map((e) => [e.level, String(e.message)]);
    expect(levels).toContainEqual(["warn", "Skipping %E0%A4%A.json in the storage directory"]);
    expect(levels).toContainEqual([
      "error",
      `Storage file ${namespaceFile("a#one")} is corrupted and could not be moved aside; starting with an empty store`,
    ]);
  });

  it("never maps a rule ID onto the shared file or outside the directory", () => {
    expect(namespaceFile("_shared")).toBe("_shared.json");
    expect(namespaceFile("_shared#x")).toBe("%5Fshared%23x.json");
    expect(namespaceFile("../evil")).toBe("%2E%2E%2Fevil.json");
    expect(() => checkJson({ a: [1, "x", null, { b: true }] }, "store.set")).not.toThrow();
  });
});
