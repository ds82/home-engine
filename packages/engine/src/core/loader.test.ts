import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RuleLoader } from "./loader.js";
import { RuleRegistry } from "./rule-registry.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";
import { FakeSources } from "./testing/fake-sources.js";
import { logCapture, type LogCapture } from "./testing/log-capture.js";

describe("RuleLoader", () => {
  let root: string;
  let capture: LogCapture;
  let registry: RuleRegistry;
  let loader: RuleLoader;

  beforeAll(() => installSdkRuntime(coreSdkRuntime()));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "he-loader-"));
    mkdirSync(join(root, "rules"));
    capture = logCapture([]);
    registry = new RuleRegistry({ sources: new FakeSources().sources, log: capture.log });
    loader = new RuleLoader({
      rulesDir: join(root, "rules"),
      buildDir: join(root, "data", ".build"),
      registry,
      log: capture.log,
    });
  });

  afterEach(async () => {
    await registry.unloadAll();
    rmSync(root, { recursive: true, force: true });
  });

  function write(file: string, content: string): void {
    mkdirSync(join(root, "rules", file, ".."), { recursive: true });
    writeFileSync(join(root, "rules", file), content);
  }

  const valid =
    'import { rule } from "@home-engine/sdk";\nrule("ok", { kind: "startup" }, () => {});\n';

  it("reports a syntax error with file, line and column and still loads the other files", async () => {
    write(
      "broken.ts",
      'import { rule } from "@home-engine/sdk";\n\nrule("x", { kind: "startup" }, () => {\n  const a = ;\n});\n',
    );
    write("valid.ts", valid);

    await loader.loadAll();

    expect(registry.listRules().map((r) => [r.id, r.status])).toEqual([["valid#ok", "running"]]);
    const broken = registry.listFiles().find((f) => f.file === "broken.ts");
    expect(broken).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/^Syntax error in broken\.ts:4:13:/),
    });
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        file: "broken.ts",
        line: 4,
        column: 13,
        message: expect.stringMatching(/^Syntax error in broken\.ts:4:13: /),
      }),
    );
  });

  it("points at a broken helper module and fails only the rule files importing it", async () => {
    write("_lib/helper.ts", "export const x = {;\n");
    write("uses-helper.ts", 'import { x } from "./_lib/helper";\nvoid x;\n');
    write("valid.ts", valid);

    await loader.loadAll();

    expect(registry.listRules().map((r) => r.id)).toEqual(["valid#ok"]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        file: "_lib/helper.ts",
        line: 1,
        ruleFile: "uses-helper.ts",
      }),
    );
  });

  it("reports a top-level runtime error with its stack and keeps loading", async () => {
    write("throws.ts", 'throw new Error("config missing");\n');
    write("valid.ts", valid);

    await loader.loadAll();

    expect(registry.listRules().map((r) => r.id)).toEqual(["valid#ok"]);
    expect(registry.listFiles().find((f) => f.file === "throws.ts")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("config missing"),
    });
  });

  it("reloads a fixed file", async () => {
    write("x.ts", "const = ;\n");
    expect(await loader.loadFile("x.ts")).toBe(false);
    write("x.ts", valid);
    expect(await loader.loadFile("x.ts")).toBe(true);
    expect(registry.listFiles()).toEqual([
      expect.objectContaining({ file: "x.ts", status: "loaded" }),
    ]);
  });

  it("logs an evaluation timeout as a warning naming the file", async () => {
    loader = new RuleLoader({
      rulesDir: join(root, "rules"),
      buildDir: join(root, "data", ".build"),
      registry,
      log: capture.log,
      evaluationTimeoutMs: 20,
    });
    write("hanging.ts", "await new Promise(() => {});\n");
    expect(await loader.loadFile("hanging.ts")).toBe(false);
    const lines = capture.entries().filter((e) => e.file === "hanging.ts");
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "Evaluating hanging.ts did not finish within 0.02 s",
      }),
    ]);
    expect(registry.listFiles()).toEqual([
      expect.objectContaining({ file: "hanging.ts", status: "failed" }),
    ]);
  });

  it("fails a file whose explicit rule ID another file uses, logging both files", async () => {
    const source =
      'import { rule } from "@home-engine/sdk";\n' +
      'rule("m", { kind: "startup" }, () => {}, { id: "kitchen" });\n';
    write("a/kitchen.ts", source);
    write("b/kitchen.ts", source);
    await loader.loadAll();
    expect(registry.rule("kitchen")).toMatchObject({ file: "a/kitchen.ts", status: "running" });
    expect(registry.listFiles().find((f) => f.file === "b/kitchen.ts")).toMatchObject({
      status: "failed",
    });
    const lines = capture.entries().filter((e) => e.file === "b/kitchen.ts");
    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        otherFile: "a/kitchen.ts",
        message: 'Rule ID "kitchen" in b/kitchen.ts is already used by a rule in a/kitchen.ts',
      }),
    ]);
  });
});
