import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRuleFiles, isRuleFile, reportDiscovery } from "./discovery.js";
import { fileIdBase } from "./registration.js";
import { logCapture } from "./testing/log-capture.js";

describe("rule file discovery", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function rulesDir(files: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "he-rules-"));
    dirs.push(dir);
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "export {};\n");
    }
    return dir;
  }

  it("finds nested rule files of every supported extension", async () => {
    const dir = rulesDir(["lights/hallway.ts", "climate.js", "a/b/c.mts", "d.mjs", "notes.md"]);
    expect((await discoverRuleFiles(dir)).files).toEqual([
      "a/b/c.mts",
      "climate.js",
      "d.mjs",
      "lights/hallway.ts",
    ]);
  });

  it("does not load helper modules in _ directories or _ files", async () => {
    const dir = rulesDir(["hallway.ts", "_lib/helpers.ts", "_shared.ts", "rooms/_util.ts"]);
    expect((await discoverRuleFiles(dir)).files).toEqual(["hallway.ts"]);
  });

  it("ignores type declarations, tests, node_modules and hidden files", async () => {
    const dir = rulesDir([
      "types.d.ts",
      "hallway.test.ts",
      "hallway.spec.mjs",
      "node_modules/foo/index.js",
      ".git/hooks/x.js",
      ".hidden.ts",
      "real.ts",
    ]);
    expect((await discoverRuleFiles(dir)).files).toEqual(["real.ts"]);
  });

  it("reports files whose rule IDs collide and loads neither", async () => {
    const dir = rulesDir([
      "hallway.ts",
      "hallway.js",
      "rooms/kitchen.ts",
      "rooms/kitchen.mjs",
      "porch.ts",
    ]);
    const result = await discoverRuleFiles(dir);
    expect(result.files).toEqual(["porch.ts"]);
    expect(result.conflicts).toEqual([
      { idBase: "hallway", files: ["hallway.js", "hallway.ts"] },
      { idBase: "rooms/kitchen", files: ["rooms/kitchen.mjs", "rooms/kitchen.ts"] },
    ]);

    const capture = logCapture([]);
    reportDiscovery(capture.log, dir, result);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("hallway.js and hallway.ts would get the same rule IDs"),
      }),
    );
  });

  it("warns when the rules directory has no rule files", async () => {
    const dir = rulesDir(["_lib/helpers.ts", "README.md"]);
    const result = await discoverRuleFiles(dir);
    expect(result.files).toEqual([]);
    const capture = logCapture([]);
    reportDiscovery(capture.log, dir, result);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: `No rule files found in ${dir}; watching for new files`,
      }),
    );
  });

  it("derives rule ID prefixes from paths", () => {
    expect(fileIdBase("lights/hallway.ts")).toBe("lights/hallway");
    expect(fileIdBase("lights\\hallway.mjs")).toBe("lights/hallway");
    expect(fileIdBase("climate.js")).toBe("climate");
  });

  it.each([
    ["hallway.ts", true],
    ["rooms/kitchen.mts", true],
    ["_lib/x.ts", false],
    ["rooms/_x.ts", false],
    ["x.d.ts", false],
    ["x.test.ts", false],
    ["node_modules/a.js", false],
    ["x.json", false],
  ])("isRuleFile(%s) is %s", (path, expected) => {
    expect(isRuleFile(path)).toBe(expected);
  });
});
