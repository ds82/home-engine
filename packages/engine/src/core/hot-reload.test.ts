import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HotReloader, type ReloadSummary } from "./hot-reload.js";
import { RuleLoader } from "./loader.js";
import { RuleRegistry } from "./rule-registry.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";
import { Storage } from "./storage.js";
import { FakeSources } from "./testing/fake-sources.js";
import { logCapture, type LogCapture } from "./testing/log-capture.js";

const ruleFile = (...names: string[]): string =>
  `import { rule } from "@home-engine/sdk";\n${names
    .map((n) => `rule(${JSON.stringify(n)}, { kind: "startup" }, () => {});`)
    .join("\n")}\n`;

describe("HotReloader", () => {
  let root: string;
  let rulesDir: string;
  let registry: RuleRegistry;
  let loader: RuleLoader;
  let reloader: HotReloader;
  let capture: LogCapture;

  beforeAll(() => installSdkRuntime(coreSdkRuntime()));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "he-reload-"));
    rulesDir = join(root, "rules");
    mkdirSync(rulesDir);
    capture = logCapture([]);
    const log = capture.log;
    registry = new RuleRegistry({ sources: new FakeSources().sources, log });
    loader = new RuleLoader({ rulesDir, buildDir: join(root, "data", ".build"), registry, log });
    reloader = new HotReloader({ rulesDir, loader, log, debounceMs: 100 });
  });

  afterEach(async () => {
    await reloader.stop();
    await registry.unloadAll();
    rmSync(root, { recursive: true, force: true });
  });

  function write(file: string, content: string): void {
    mkdirSync(join(rulesDir, file, ".."), { recursive: true });
    writeFileSync(join(rulesDir, file), content);
  }

  async function start(): Promise<void> {
    await loader.loadAll();
    await reloader.start();
  }

  function nextReload(): Promise<ReloadSummary> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no reload within 5 s")), 5_000);
      const off = reloader.onReload((summary) => {
        clearTimeout(timeout);
        off();
        resolve(summary);
      });
    });
  }

  const ids = (): string[] =>
    registry
      .listRules()
      .map((r) => r.id)
      .sort();

  it("reloads an edited file and leaves other files untouched", async () => {
    write("lights.ts", ruleFile("hall"));
    write("climate.ts", ruleFile("heating"));
    await start();
    const heatingLoadedAt = registry.rule("climate#heating")?.loadedAt;

    const reload = nextReload();
    write("lights.ts", ruleFile("hall", "porch"));
    expect(await reload).toEqual({ reloaded: ["lights.ts"], unloaded: [] });
    expect(ids()).toEqual(["climate#heating", "lights#hall", "lights#porch"]);
    expect(registry.rule("climate#heating")?.loadedAt).toBe(heatingLoadedAt);
  });

  it("unloads the rules of a deleted file", async () => {
    write("lights.ts", ruleFile("hall"));
    write("climate.ts", ruleFile("heating"));
    await start();

    const reload = nextReload();
    unlinkSync(join(rulesDir, "lights.ts"));
    expect(await reload).toEqual({ reloaded: [], unloaded: ["lights.ts"] });
    expect(ids()).toEqual(["climate#heating"]);
    expect(registry.listFiles().map((f) => f.file)).toEqual(["climate.ts"]);
  });

  it("loads a newly added file", async () => {
    write("climate.ts", ruleFile("heating"));
    await start();

    const reload = nextReload();
    write("rooms/kitchen.ts", ruleFile("motion"));
    expect(await reload).toEqual({ reloaded: ["rooms/kitchen.ts"], unloaded: [] });
    expect(ids()).toEqual(["climate#heating", "rooms/kitchen#motion"]);
  });

  it("keeps a rule with an explicit ID and its stored values when its file moves", async () => {
    const storage = new Storage(join(root, "data", "storage"), capture.log);
    await storage.load();
    installSdkRuntime(coreSdkRuntime(undefined, storage));
    try {
      write(
        "rooms/kitchen.ts",
        [
          'import { setup, store } from "@home-engine/sdk";',
          'setup("counter", () => {',
          '  store.set("starts", (store.get<number>("starts") ?? 0) + 1);',
          '}, { id: "kitchen" });',
        ].join("\n"),
      );
      await start();
      expect(storage.namespace("kitchen").get("starts")).toBe(1);

      // Moved to a path that sorts before the old one, in one batch.
      const reload = nextReload();
      mkdirSync(join(rulesDir, "a"));
      renameSync(join(rulesDir, "rooms", "kitchen.ts"), join(rulesDir, "a", "kitchen.ts"));
      expect(await reload).toEqual({ reloaded: ["a/kitchen.ts"], unloaded: ["rooms/kitchen.ts"] });
      expect(registry.rule("kitchen")).toMatchObject({ file: "a/kitchen.ts", status: "running" });
      expect(storage.namespace("kitchen").get("starts")).toBe(2);
    } finally {
      installSdkRuntime(coreSdkRuntime());
    }
  });

  it("applies the .ts/.js conflict rule when a conflicting file appears or goes away", async () => {
    write("hallway.ts", ruleFile("motion"));
    await start();
    expect(ids()).toEqual(["hallway#motion"]);

    let reload = nextReload();
    write("hallway.js", ruleFile("motion"));
    expect(await reload).toEqual({ reloaded: [], unloaded: ["hallway.ts"] });
    expect(ids()).toEqual([]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringMatching(/hallway\.js.*hallway\.ts|hallway\.ts.*hallway\.js/),
      }),
    );

    reload = nextReload();
    unlinkSync(join(rulesDir, "hallway.js"));
    expect(await reload).toEqual({ reloaded: ["hallway.ts"], unloaded: [] });
    expect(ids()).toEqual(["hallway#motion"]);
  });

  it("reloads every rule file that imports a changed helper, directly or indirectly", async () => {
    write("_lib/helpers.ts", 'export const suffix = "v1";\n');
    write(
      "_lib/names.ts",
      'import { suffix } from "./helpers";\nexport const name = (n: string) => `${n}-${suffix}`;\n',
    );
    write(
      "hallway.ts",
      'import { rule } from "@home-engine/sdk";\nimport { suffix } from "./_lib/helpers";\nrule(`hall-${suffix}`, { kind: "startup" }, () => {});\n',
    );
    write(
      "porch.ts",
      'import { rule } from "@home-engine/sdk";\nimport { name } from "./_lib/names";\nrule(name("porch"), { kind: "startup" }, () => {});\n',
    );
    write("climate.ts", ruleFile("heating"));
    await start();
    expect(ids()).toEqual(["climate#heating", "hallway#hall-v1", "porch#porch-v1"]);

    const reload = nextReload();
    write("_lib/helpers.ts", 'export const suffix = "v2";\n');
    expect(await reload).toEqual({ reloaded: ["hallway.ts", "porch.ts"], unloaded: [] });
    expect(ids()).toEqual(["climate#heating", "hallway#hall-v2", "porch#porch-v2"]);
  });

  it("reloads once for a burst of saves", async () => {
    write("lights.ts", ruleFile("v0"));
    await start();
    const loadFile = vi.spyOn(loader, "loadFile");

    const reload = nextReload();
    for (const version of ["v1", "v2", "v3"]) {
      write("lights.ts", ruleFile(version));
      await sleep(40);
    }
    await reload;
    await sleep(300);
    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(["lights#v3"]);
  });
});

describe("HotReloader switches and broken edits", () => {
  let root: string;
  let rulesDir: string;
  let registry: RuleRegistry;
  let loader: RuleLoader;
  let reloader: HotReloader | undefined;
  let capture: ReturnType<typeof logCapture>;

  beforeAll(() => installSdkRuntime(coreSdkRuntime()));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "he-reload2-"));
    rulesDir = join(root, "rules");
    mkdirSync(rulesDir);
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

  function waitForReload(r: HotReloader): Promise<ReloadSummary> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no reload within 5 s")), 5_000);
      const off = r.onReload((s) => {
        clearTimeout(timeout);
        off();
        resolve(s);
      });
    });
  }

  it("does not reload anything with HOT_RELOAD=false", async () => {
    writeFileSync(join(rulesDir, "lights.ts"), ruleFile("v1"));
    await loader.loadAll();
    reloader = new HotReloader({
      rulesDir,
      loader,
      log: capture.log,
      enabled: false,
      debounceMs: 50,
    });
    await reloader.start();
    expect(reloader.mode).toBe("disabled");
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: expect.stringMatching(/Hot reload is disabled/),
      }),
    );

    writeFileSync(join(rulesDir, "lights.ts"), ruleFile("v2"));
    writeFileSync(join(rulesDir, "new.ts"), ruleFile("added"));
    await sleep(400);
    expect(registry.listRules().map((r) => r.id)).toEqual(["lights#v1"]);
  });

  it("unloads the previous rules on a broken edit, logs the error and recovers on fix", async () => {
    writeFileSync(join(rulesDir, "lights.ts"), ruleFile("v1"));
    await loader.loadAll();
    reloader = new HotReloader({ rulesDir, loader, log: capture.log, debounceMs: 50 });
    await reloader.start();

    let reload = waitForReload(reloader);
    writeFileSync(
      join(rulesDir, "lights.ts"),
      'import { rule } from "@home-engine/sdk";\nrule("v2", {;\n',
    );
    await reload;
    expect(registry.listRules()).toEqual([]);
    expect(registry.listFiles()).toEqual([
      expect.objectContaining({
        file: "lights.ts",
        status: "failed",
        error: expect.stringMatching(/^Syntax error in lights\.ts:2:/),
      }),
    ]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({ level: "error", file: "lights.ts", line: 2 }),
    );

    reload = waitForReload(reloader);
    writeFileSync(join(rulesDir, "lights.ts"), ruleFile("v3"));
    await reload;
    expect(registry.listRules().map((r) => [r.id, r.status])).toEqual([["lights#v3", "running"]]);
    expect(registry.listFiles()).toEqual([
      expect.objectContaining({ file: "lights.ts", status: "loaded" }),
    ]);
  });
});
