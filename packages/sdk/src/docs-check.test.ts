// Runs scripts/check-docs.mjs as a CLI against small fixture doc folders.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/check-docs.mjs", import.meta.url));

function run(root: string): { code: number; output: string } {
  try {
    const out = execFileSync(process.execPath, [script, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, output: e.stdout + e.stderr };
  }
}

const good = [
  "# Example",
  "",
  "```ts",
  'import { setup, listen, type StateTrigger } from "@home-engine/sdk";',
  "",
  'const motion: StateTrigger = { kind: "state", entities: ["binary_sensor.motion"] };',
  'setup("counter", () => {',
  "  let n = 0;",
  "  listen(motion, () => {",
  "    n++;",
  "  });",
  "});",
  "```",
  "",
].join("\n");

// Every test starts a Node process that loads TypeScript and ESLint; a cold CI runner needs
// more than the default 5 s for the first one.
describe("docs type-check script", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "he-docs-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it("passes for valid samples in README.md and docs/**", () => {
    const result = run(fixture({ "README.md": good, "docs/rules/triggers.md": good }));
    expect(result.output).toContain("2 TypeScript block(s), 0 error(s)");
    expect(result.code).toBe(0);
  });

  it("fails on a deliberately broken sample and points at the Markdown line", () => {
    const broken = [
      "Intro",
      "",
      "```typescript",
      'import { rule } from "@home-engine/sdk";',
      'rule("missing body", { kind: "startup" });',
      "```",
    ].join("\n");
    const result = run(fixture({ "docs/broken.md": broken }));
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/docs\/broken\.md:5:\d+ - error TS2554/);
  });

  it("skips blocks marked nocheck and ignores other languages", () => {
    const md = [
      "```ts nocheck",
      "this is not valid typescript",
      "```",
      "```js",
      "also ignored(",
      "```",
    ].join("\n");
    const result = run(fixture({ "README.md": md }));
    expect(result.code).toBe(0);
    expect(result.output).toContain("0 TypeScript block(s), 0 error(s)");
  });

  it("skips the generated reference, the site configuration and dependencies", () => {
    const broken = ["```ts", 'const n: number = "not a number";', "```"].join("\n");
    const result = run(
      fixture({
        "docs/rules/triggers.md": good,
        "docs/api/functions/rule.md": broken,
        "docs/.vitepress/notes.md": broken,
        "docs/node_modules/pkg/README.md": broken,
      }),
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("1 TypeScript block(s), 0 error(s)");
  });
});
