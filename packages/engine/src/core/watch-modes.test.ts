import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { watch, type ChokidarOptions } from "chokidar";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WatchPollMode } from "./config.js";
import { HotReloader, type ReloadSummary, type Watcher } from "./hot-reload.js";
import { RuleLoader } from "./loader.js";
import { RuleRegistry } from "./rule-registry.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";
import { FakeSources } from "./testing/fake-sources.js";
import { logCapture, type LogCapture } from "./testing/log-capture.js";

const ruleFile = (name: string): string =>
  `import { rule } from "@home-engine/sdk";\nrule(${JSON.stringify(name)}, { kind: "startup" }, () => {});\n`;

function enospc(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    "ENOSPC: System limit for number of file watchers reached",
  );
  err.code = "ENOSPC";
  return err;
}

/** A native watcher that fails like an exhausted inotify limit; polling watchers are real. */
function failingNative(when: "setup" | "later", requests: ChokidarOptions[]) {
  return (path: string, options: ChokidarOptions): Watcher => {
    requests.push(options);
    if (options.usePolling) {
      return watch(path, options);
    }
    const fake = new EventEmitter() as Watcher;
    fake.close = async () => {};
    setImmediate(() => {
      if (when === "later") {
        fake.emit("ready");
      }
      fake.emit("error", enospc());
    });
    return fake;
  };
}

describe("file watching modes (WATCH_POLL)", () => {
  let root: string;
  let rulesDir: string;
  let capture: LogCapture;
  let registry: RuleRegistry;
  let loader: RuleLoader;
  let reloader: HotReloader | undefined;

  beforeAll(() => installSdkRuntime(coreSdkRuntime()));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "he-watch-"));
    rulesDir = join(root, "rules");
    mkdirSync(rulesDir);
    writeFileSync(join(rulesDir, "lights.ts"), ruleFile("v1"));
    capture = logCapture([]);
    registry = new RuleRegistry({ sources: new FakeSources().sources, log: capture.log });
    loader = new RuleLoader({
      rulesDir,
      buildDir: join(root, "data", ".build"),
      registry,
      log: capture.log,
    });
  });

  afterEach(async () => {
    await reloader?.stop();
    reloader = undefined;
    await registry.unloadAll();
    rmSync(root, { recursive: true, force: true });
  });

  async function startReloader(
    watchPoll: WatchPollMode,
    watchFactory?: ConstructorParameters<typeof HotReloader>[0]["watchFactory"],
  ) {
    await loader.loadAll();
    reloader = new HotReloader({
      rulesDir,
      loader,
      log: capture.log,
      watchPoll,
      ...(watchFactory ? { watchFactory } : {}),
    });
    await reloader.start();
    return reloader;
  }

  /** Saves a new version and resolves with the time until it was reloaded. */
  async function timeReload(r: HotReloader, name: string): Promise<number> {
    // chokidar's polling takes its baseline stat of each file shortly after "ready"; a write
    // landing before that (only plausible within milliseconds of startup) is never seen.
    await sleep(100);
    const started = Date.now();
    const reloaded = new Promise<ReloadSummary>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("not reloaded within 5 s")), 5_000);
      const off = r.onReload((s) => {
        clearTimeout(timeout);
        off();
        resolve(s);
      });
    });
    writeFileSync(join(rulesDir, "lights.ts"), ruleFile(name));
    await reloaded;
    expect(registry.listRules().map((x) => x.name)).toEqual([name]);
    return Date.now() - started;
  }

  it("uses native notifications when they work (auto)", async () => {
    const requests: ChokidarOptions[] = [];
    const r = await startReloader("auto", (p, o) => {
      requests.push(o);
      return watch(p, o);
    });
    expect(r.mode).toBe("native");
    expect(requests.map((o) => o.usePolling)).toEqual([false]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({ level: "info", watchMode: "native" }),
    );
    await timeReload(r, "v2");
  });

  it("falls back to polling when setting up native watching fails with ENOSPC, and reloads within 2 s", async () => {
    const requests: ChokidarOptions[] = [];
    const r = await startReloader("auto", failingNative("setup", requests));
    expect(r.mode).toBe("polling");
    expect(requests.map((o) => o.usePolling)).toEqual([false, true]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        reason: "ENOSPC",
        message: expect.stringMatching(/falling back to polling/),
      }),
    );
    expect(await timeReload(r, "v2")).toBeLessThan(2_000);
  }, 10_000);

  it("also falls back when native watching fails while running", async () => {
    const requests: ChokidarOptions[] = [];
    const r = await startReloader("auto", failingNative("later", requests));
    await sleep(50);
    expect(r.mode).toBe("polling");
    expect(await timeReload(r, "v2")).toBeLessThan(2_000);
  }, 10_000);

  it("polls from the start with WATCH_POLL=true and reloads within 2 s", async () => {
    const requests: ChokidarOptions[] = [];
    const r = await startReloader("true", (p, o) => {
      requests.push(o);
      return watch(p, o);
    });
    expect(r.mode).toBe("polling");
    expect(requests.map((o) => o.usePolling)).toEqual([true]);
    expect(await timeReload(r, "v2")).toBeLessThan(2_000);
  }, 10_000);

  it("gives up with an error when native watching fails and WATCH_POLL=false", async () => {
    const requests: ChokidarOptions[] = [];
    const r = await startReloader("false", failingNative("setup", requests));
    expect(r.mode).toBe("unavailable");
    expect(requests.map((o) => o.usePolling)).toEqual([false]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringMatching(/hot reload is unavailable/),
      }),
    );

    writeFileSync(join(rulesDir, "lights.ts"), ruleFile("v2"));
    await sleep(500);
    expect(registry.listRules().map((x) => [x.name, x.status])).toEqual([["v1", "running"]]);
  });
});
