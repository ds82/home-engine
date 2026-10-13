// Runs scripts/check-docs-links.mjs as a CLI against small fixture builds.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/check-docs-links.mjs", import.meta.url));

function run(dist: string, base?: string): { code: number; output: string } {
  const env = { ...process.env, DOCS_BASE: base ?? "" };
  try {
    const out = execFileSync(process.execPath, [script, "--dist", dist], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, output: e.stdout + e.stderr };
  }
}

const page = (body: string): string => `<html><body>${body}</body></html>`;

describe("docs anchor check", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function build(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "he-docs-links-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it("passes when every anchor exists", () => {
    const dist = build({
      "index.html": page('<a href="/rules/triggers.html#holds">holds</a>'),
      "rules/triggers.html": page('<h2 id="holds">Holds</h2><a href="#holds">#</a>'),
      "rules/scheduling.html": page('<a href="./triggers.html#holds">holds</a>'),
    });
    const result = run(dist);
    expect(result.output).toContain("3 anchor link(s) on 3 page(s), 0 broken");
    expect(result.code).toBe(0);
  });

  it("fails on a missing anchor and names the source page and the target", () => {
    const dist = build({
      "rules/triggers.html": page('<h2 id="holds">Holds</h2>'),
      "rules/scheduling.html": page('<a href="./triggers.html#missing-heading">x</a>'),
    });
    const result = run(dist);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "rules/scheduling.html → ./triggers.html#missing-heading (no anchor #missing-heading",
    );
  });

  it("resolves absolute links under the base path and ignores other sites", () => {
    const dist = build({
      "index.html": page(
        [
          '<a href="/home-engine/status.html#rule-status">status</a>',
          '<a href="https://example.com/x.html#nowhere">external</a>',
          '<a href="/elsewhere/page.html#nowhere">other path</a>',
        ].join(""),
      ),
      "status.html": page('<h2 id="rule-status">Rule status</h2>'),
    });
    const result = run(dist, "/home-engine/");
    expect(result.output).toContain("1 anchor link(s) on 2 page(s), 0 broken");
    expect(result.code).toBe(0);
  });

  it("ignores links and IDs inside inline scripts", () => {
    const dist = build({
      "index.html": page('<script>const a = \' href="#ghost"\';</script><p id="real">x</p>'),
    });
    const result = run(dist);
    expect(result.output).toContain("0 anchor link(s) on 1 page(s), 0 broken");
  });
});
