import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DependencyGraph, bundleRuleFile, importBundle } from "./bundler.js";
import { evaluateFile } from "./registration.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";

describe("rule file bundling", () => {
  let root: string;
  let rulesDir: string;
  let buildDir: string;

  beforeAll(() => installSdkRuntime(coreSdkRuntime()));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "he-bundle-"));
    rulesDir = join(root, "rules");
    buildDir = join(root, "data", ".build");
    mkdirSync(rulesDir, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function write(file: string, content: string): void {
    mkdirSync(join(rulesDir, file, ".."), { recursive: true });
    writeFileSync(join(rulesDir, file), content);
  }

  async function load(file: string) {
    const bundle = await bundleRuleFile({ rulesDir, file, buildDir });
    const rules = await evaluateFile(file, () => importBundle(bundle.outfile));
    return { bundle, rules };
  }

  it("loads a TypeScript rule file with enums, interfaces and a local helper module", async () => {
    write(
      "_lib/helpers.ts",
      "export function label(room: string): string {\n  return `motion-${room}`;\n}\n",
    );
    write(
      "lights/hallway.ts",
      [
        'import { rule } from "@home-engine/sdk";',
        'import { label } from "../_lib/helpers";',
        "",
        "enum Room {",
        '  Hall = "hall",',
        '  Porch = "porch",',
        "}",
        "interface Spec {",
        "  room: Room;",
        "  entity: string;",
        "}",
        "const specs: Spec[] = [",
        '  { room: Room.Hall, entity: "binary_sensor.hall_motion" },',
        '  { room: Room.Porch, entity: "binary_sensor.porch_motion" },',
        "];",
        "for (const spec of specs) {",
        '  rule(label(spec.room), { kind: "state", entities: [spec.entity] }, () => {});',
        "}",
      ].join("\n"),
    );

    const { bundle, rules } = await load("lights/hallway.ts");
    expect(rules.map((r) => r.id)).toEqual([
      "lights/hallway#motion-hall",
      "lights/hallway#motion-porch",
    ]);
    expect(bundle.outfile).toMatch(/data\/\.build\/lights\/hallway\.ts\.[0-9a-f]{12}\.mjs$/);
    expect(bundle.inputs.sort()).toEqual([
      join(rulesDir, "_lib/helpers.ts"),
      join(rulesDir, "lights/hallway.ts"),
    ]);
  });

  it("maps stack traces back to the original .ts line", async () => {
    write(
      "boom.ts",
      [
        "interface Unused {",
        "  a: number;",
        "}",
        "const value: number = 1 + 1;",
        "throw new Error(`boom ${value}`);",
      ].join("\n"),
    );
    const { outfile } = await bundleRuleFile({ rulesDir, file: "boom.ts", buildDir });
    // Plain Node, not vitest's module runner, so this checks Node's own source map support.
    const script = `process.setSourceMapsEnabled(true); import(${JSON.stringify(
      pathToFileURL(outfile).href,
    )}).catch((e) => { console.log(e.stack); });`;
    const stack = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    expect(stack).toContain("boom 2");
    expect(stack).toContain(`${join(rulesDir, "boom.ts")}:5:`);
  });

  it("lets rules read custom environment variables", async () => {
    process.env.PUSHOVER_KEY = "abc";
    write(
      "notify.ts",
      'import { rule } from "@home-engine/sdk";\nrule(`notify-${process.env.PUSHOVER_KEY}`, { kind: "startup" }, () => {});\n',
    );
    const { rules } = await load("notify.ts");
    expect(rules.map((r) => r.name)).toEqual(["notify-abc"]);
    delete process.env.PUSHOVER_KEY;
  });

  it("names bundles by content hash, so a changed file is evaluated afresh", async () => {
    const source = (n: number): string =>
      `import { rule } from "@home-engine/sdk";\nrule("r${n}", { kind: "startup" }, () => {});\n`;
    write("x.ts", source(1));
    const first = await load("x.ts");
    const again = await bundleRuleFile({ rulesDir, file: "x.ts", buildDir });
    expect(again.outfile).toBe(first.bundle.outfile);

    write("x.ts", source(2));
    const second = await load("x.ts");
    expect(second.bundle.outfile).not.toBe(first.bundle.outfile);
    expect(second.rules.map((r) => r.name)).toEqual(["r2"]);
  });

  it("keeps npm packages external and inlines no SDK code", async () => {
    write(
      "ext.ts",
      'import { format } from "date-fns";\nimport { rule } from "@home-engine/sdk";\nvoid format;\nvoid rule;\n',
    );
    const { outfile } = await bundleRuleFile({ rulesDir, file: "ext.ts", buildDir });
    const code = readFileSync(outfile, "utf8");
    expect(code).toMatch(/from "date-fns"/);
    expect(code).toContain('Symbol.for("home-engine.sdk")');
    expect(code).toContain("sourceMappingURL=data:application/json;base64,");
  });
});

describe("DependencyGraph", () => {
  it("finds the rule files that include a changed source file", () => {
    const graph = new DependencyGraph();
    graph.set("hallway.ts", ["/rules/hallway.ts", "/rules/_lib/helpers.ts"]);
    graph.set("porch.ts", ["/rules/porch.ts", "/rules/_lib/helpers.ts"]);
    graph.set("climate.ts", ["/rules/climate.ts"]);
    expect(graph.dependents("/rules/_lib/helpers.ts")).toEqual(["hallway.ts", "porch.ts"]);
    expect(graph.dependents("/rules/climate.ts")).toEqual(["climate.ts"]);
    graph.delete("porch.ts");
    expect(graph.dependents("/rules/_lib/helpers.ts")).toEqual(["hallway.ts"]);
  });
});
