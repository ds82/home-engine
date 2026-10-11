// Rule storage (rule-storage; design D8). One JSON file per namespace in `<DATA_DIR>/storage`:
// `<encoded-rule-id>.json` for each rule's `store` and `_shared.json` for `shared`. Values are
// kept in memory, so reads are synchronous; writes mark their namespace dirty and a flush at
// most FLUSH_DELAY_MS later (and on shutdown) writes tmp → fsync → rename. Files of rules that
// no longer exist are kept, so renaming or removing a rule for a while loses nothing.

import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import { requireRun } from "./run-context.js";

/** Longest time between a write and its flush to disk. */
export const FLUSH_DELAY_MS = 500;

export const SHARED_NAMESPACE = "_shared";
const FILE_VERSION = 1;

export interface KeyValueStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys(): string[];
}

/** File name of a namespace; a rule ID can never map to the shared file. */
export function namespaceFile(namespace: string): string {
  if (namespace === SHARED_NAMESPACE) return `${SHARED_NAMESPACE}.json`;
  return `${encodeURIComponent(namespace).replace(/^_/, "%5F").replace(/\./g, "%2E")}.json`;
}

/**
 * Throws a TypeError naming the offending path unless `value` is plain JSON data: null,
 * booleans, finite numbers, strings, arrays and plain objects, without cycles.
 */
export function checkJson(value: unknown, fn: string, path = "value", seen = new Set()): void {
  const fail = (what: string): never => {
    throw new TypeError(`${fn}(): ${path} ${what}; stored values must be plain JSON data`);
  };
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`is ${value}`);
    return;
  }
  if (typeof value !== "object") {
    fail(value === undefined ? "is undefined" : `is a ${typeof value}`);
  }
  if (seen.has(value)) fail("is a circular reference");
  const proto = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    const name = (value as object).constructor?.name ?? "object";
    fail(`is a ${name}${value instanceof Date ? " (store date.toISOString() instead)" : ""}`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkJson(item, fn, `${path}[${i}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      checkJson(item, fn, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

export interface StorageOptions {
  flushDelayMs?: number;
  now?: () => number;
}

export class Storage {
  private readonly namespaces = new Map<string, Map<string, unknown>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly flushDelayMs: number;
  private readonly now: () => number;

  /** `dir` is `<DATA_DIR>/storage`. */
  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    options: StorageOptions = {},
  ) {
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  /** Reads every namespace file. Unreadable files are moved aside and start empty. */
  async load(): Promise<void> {
    if (!existsSync(this.dir)) return;
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const namespace =
        name === `${SHARED_NAMESPACE}.json`
          ? SHARED_NAMESPACE
          : decodeURIComponent(name.slice(0, -".json".length));
      const file = join(this.dir, name);
      try {
        const data = JSON.parse(await readFile(file, "utf8")) as unknown;
        const values = (data as { values?: unknown } | null)?.values;
        if (typeof values !== "object" || values === null || Array.isArray(values)) {
          throw new Error("no values object");
        }
        this.namespaces.set(namespace, new Map(Object.entries(values)));
      } catch (err) {
        const aside = `${file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
        await rename(file, aside);
        this.log.error(
          { err, file, movedTo: aside },
          `Storage file ${name} is corrupted; moved it aside and starting with an empty store`,
        );
      }
    }
  }

  /** The key/value store of one namespace (a rule ID, or SHARED_NAMESPACE). */
  namespace(namespace: string): KeyValueStore {
    const values = (): Map<string, unknown> => {
      let map = this.namespaces.get(namespace);
      if (!map) this.namespaces.set(namespace, (map = new Map()));
      return map;
    };
    const fn = namespace === SHARED_NAMESPACE ? "shared" : "store";
    const checkKey = (method: string, key: unknown): string => {
      if (typeof key !== "string" || key === "") {
        throw new TypeError(`${fn}.${method}(): the key must be a non-empty string`);
      }
      return key;
    };
    return {
      get: <T>(key: string) => copy(values().get(checkKey("get", key)) as T | undefined),
      set: (key, value) => {
        checkKey("set", key);
        checkJson(value, `${fn}.set`);
        values().set(key, copy(value));
        this.markDirty(namespace);
      },
      delete: (key) => {
        const deleted = values().delete(checkKey("delete", key));
        if (deleted) this.markDirty(namespace);
        return deleted;
      },
      keys: () => [...values().keys()],
    };
  }

  /** Writes all pending changes now; resolves when they are on disk. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = [...this.dirty];
    this.dirty.clear();
    const snapshots = pending.map((namespace) => ({
      file: join(this.dir, namespaceFile(namespace)),
      text: `${JSON.stringify(
        { version: FILE_VERSION, values: Object.fromEntries(this.namespaces.get(namespace) ?? []) },
        null,
        2,
      )}\n`,
    }));
    this.writing = this.writing.then(async () => {
      if (snapshots.length === 0) return;
      await mkdir(this.dir, { recursive: true });
      for (const { file, text } of snapshots) {
        try {
          await writeAtomically(file, text);
        } catch (err) {
          this.log.error({ err, file }, "Writing a storage file failed");
        }
      }
    });
    return this.writing;
  }

  private markDirty(namespace: string): void {
    this.dirty.add(namespace);
    this.timer ??= setTimeout(() => void this.flush(), this.flushDelayMs);
  }
}

/** Writes `text` to `file` so that a crash leaves either the old or the new content. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/** The SDK's `store` (per calling rule) and `shared` objects. */
export function storageSdk(storage: Storage): { store: KeyValueStore; shared: KeyValueStore } {
  const current = (method: string): KeyValueStore =>
    storage.namespace(requireRun(`store.${method}`).scope.ruleId);
  return {
    store: {
      get: (key) => current("get").get(key),
      set: (key, value) => current("set").set(key, value),
      delete: (key) => current("delete").delete(key),
      keys: () => current("keys").keys(),
    },
    shared: storage.namespace(SHARED_NAMESPACE),
  };
}
