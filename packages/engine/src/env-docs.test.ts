// Keeps the environment variable table in docs/configuration.md in sync with what the config
// code reads.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readHomeAssistantConfig } from "./adapters/home-assistant/config.js";
import { loadConfig, type Env } from "./core/config.js";

/** Every variable name the config loader reads, collected through a recording env object. */
function variablesReadByConfig(): string[] {
  const read = new Set<string>();
  const env = new Proxy({} as Env, {
    get(_target, name) {
      if (typeof name === "string") {
        read.add(name);
      }
      return undefined;
    },
  });
  try {
    loadConfig(env, readHomeAssistantConfig, { checkRulesDir: () => undefined });
  } catch {
    // An empty environment is invalid; we only care about which names were read.
  }
  return [...read].sort();
}

function configurationGuide(): string {
  return readFileSync(
    fileURLToPath(new URL("../../../docs/configuration.md", import.meta.url)),
    "utf8",
  );
}

function variablesInGuide(): string[] {
  return [...configurationGuide().matchAll(/^\| `([A-Z][A-Z0-9_]*)` +\|/gm)]
    .map((m) => m[1] ?? "")
    .sort();
}

describe("configuration guide table", () => {
  it("documents exactly the variables the config code reads", () => {
    const documented = variablesInGuide();
    expect(documented.length).toBeGreaterThan(0);
    expect(documented).toEqual(variablesReadByConfig());
  });

  it("gives every variable a default and a description", () => {
    const rows = configurationGuide().match(/^\| `[A-Z][A-Z0-9_]*` .*$/gm) ?? [];
    for (const row of rows) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      expect(cells, row).toHaveLength(3);
      expect(cells[1], row).not.toBe("");
      expect(cells[2], row).not.toBe("");
    }
  });
});
