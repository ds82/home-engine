import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bundleRuleFile, importBundle } from "./bundler.js";
import { evaluateFile } from "./registration.js";
import { RuleRegistry } from "./rule-registry.js";
import { RuleScopeImpl } from "./rule-scope.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";
import { FakeSources } from "./testing/fake-sources.js";
import { logCapture } from "./testing/log-capture.js";

declare global {
  var __fired: string[];
}

describe("scoped native timers in rule files", () => {
  let root: string;
  let fake: FakeSources;
  let registry: RuleRegistry;
  const log = logCapture([]).log;

  beforeAll(() => installSdkRuntime(coreSdkRuntime()));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "he-timers-"));
    mkdirSync(join(root, "rules"));
    fake = new FakeSources();
    registry = new RuleRegistry({ sources: fake.sources, log });
    globalThis.__fired = [];
  });

  afterEach(async () => {
    await registry.unloadAll();
    rmSync(root, { recursive: true, force: true });
  });

  async function load(file: string, source: string): Promise<string> {
    writeFileSync(join(root, "rules", file), source);
    const bundle = await bundleRuleFile({
      rulesDir: join(root, "rules"),
      file,
      buildDir: join(root, "build"),
    });
    const fileScope = new RuleScopeImpl(`file:${file}`, log);
    const rules = await evaluateFile(file, () => importBundle(bundle.outfile), { fileScope });
    await registry.loadFile(file, rules, fileScope);
    return bundle.outfile;
  }

  const ruleSource = (version: string): string => `
    import { rule } from "@home-engine/sdk";
    setTimeout(() => globalThis.__fired.push("top-level ${version}"), 40);
    rule("t", { kind: "state", entities: ["binary_sensor.motion"] }, () => {
      setTimeout(() => globalThis.__fired.push("body ${version}"), 40);
    });
  `;

  it("replaces the timer globals in rule code with the scoped versions", async () => {
    const outfile = await load("x.ts", ruleSource("v1"));
    expect(readFileSync(outfile, "utf8")).toContain('Symbol.for("home-engine.timers")');
  });

  it("never fires a raw setTimeout of an old file version after a reload", async () => {
    await load("x.ts", ruleSource("v1"));
    fake.change("binary_sensor.motion");
    await sleep(5);

    await registry.unloadFile("x.ts");
    await load("x.ts", ruleSource("v2"));
    await sleep(80);

    expect(globalThis.__fired).toEqual(["top-level v2"]);
  });

  it("lets timers fire normally while the rule is loaded", async () => {
    await load("x.ts", ruleSource("v1"));
    fake.change("binary_sensor.motion");
    await sleep(80);
    expect(globalThis.__fired.sort()).toEqual(["body v1", "top-level v1"]);
  });

  it("keeps module-level clearTimeout working across rules", async () => {
    await load(
      "y.ts",
      `
      import { rule } from "@home-engine/sdk";
      let handle: ReturnType<typeof setTimeout> | undefined;
      rule("arm", { kind: "state", entities: ["binary_sensor.motion"] }, () => {
        handle = setTimeout(() => globalThis.__fired.push("armed"), 40);
      });
      rule("cancel", { kind: "state", entities: ["binary_sensor.door"] }, () => {
        clearTimeout(handle);
      });
    `,
    );
    fake.change("binary_sensor.motion");
    await sleep(5);
    fake.change("binary_sensor.door");
    await sleep(80);
    expect(globalThis.__fired).toEqual([]);
  });

  it("stops setInterval on unload", async () => {
    await load(
      "z.ts",
      `
      import { rule } from "@home-engine/sdk";
      rule("tick", { kind: "startup" }, () => {
        setInterval(() => globalThis.__fired.push("tick"), 10);
      });
    `,
    );
    await sleep(35);
    await registry.unloadFile("z.ts");
    const ticks = globalThis.__fired.length;
    expect(ticks).toBeGreaterThan(0);
    await sleep(40);
    expect(globalThis.__fired.length).toBe(ticks);
  });

  it("clears top-level timers of a file whose evaluation fails", async () => {
    await expect(
      load(
        "broken.ts",
        `
        setTimeout(() => globalThis.__fired.push("orphan"), 20);
        throw new Error("broken file");
      `,
      ),
    ).rejects.toThrow("broken file");
    await sleep(50);
    expect(globalThis.__fired).toEqual([]);
  });

  it("never fires a timer that a timed-out file starts after the timeout", async () => {
    writeFileSync(
      join(root, "rules", "slow.ts"),
      `
      import { setTimeout as wait } from "node:timers/promises";
      // A slow call outside the file's timers (like a network request) keeps it running.
      await wait(40);
      setTimeout(() => globalThis.__fired.push("late timer"), 10);
      `,
    );
    const bundle = await bundleRuleFile({
      rulesDir: join(root, "rules"),
      file: "slow.ts",
      buildDir: join(root, "build"),
    });
    const fileScope = new RuleScopeImpl("file:slow.ts", log);
    await expect(
      evaluateFile("slow.ts", () => importBundle(bundle.outfile), { fileScope, timeoutMs: 10 }),
    ).rejects.toThrow(/did not finish within/);
    // The next file is loading while the slow file starts its timer.
    await load("next.ts", `await new Promise((resolve) => setTimeout(resolve, 50));`);
    await sleep(30);
    expect(globalThis.__fired).toEqual([]);
    expect(fileScope.activeTimers).toBe(0);
  });
});
