// Type-level tests: each fixture project must compile. Fixtures assert expected errors with
// `@ts-expect-error`, so a missing error fails the compile as well. The augmented fixture
// needs its own compilation because module augmentation is global to a program.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

function compile(fixture: string): string {
  const project = fileURLToPath(new URL(`../type-tests/${fixture}/tsconfig.json`, import.meta.url));
  try {
    execFileSync(process.execPath, [tsc, "-p", project], { encoding: "utf8" });
    return "";
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? err);
  }
}

describe("SDK types", () => {
  it("narrows events by type and keeps IDs as strings without generated typings", () => {
    expect(compile("plain")).toBe("");
  });

  it("narrows entity IDs, states and services with generated typings", () => {
    expect(compile("augmented")).toBe("");
  });
});
