import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installRuleDependencies } from "./dependencies.js";
import { RuleLoader } from "./loader.js";
import { RuleRegistry } from "./rule-registry.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";
import { FakeSources } from "./testing/fake-sources.js";
import { logCapture } from "./testing/log-capture.js";

// Integration tests with a real npm and a local tarball dependency; no network access.
describe("rule dependency installation", () => {
  let root: string;
  let tarball: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    installSdkRuntime(coreSdkRuntime());
    root = mkdtempSync(join(tmpdir(), "he-deps-"));
    const pkg = join(root, "greeter");
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "greeter", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), "export const greet = (n) => `hello ${n}`;\n");
    const name = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], {
      cwd: pkg,
      encoding: "utf8",
    }).trim();
    tarball = join(root, name);
    env = {
      npm_config_cache: join(root, "npm-cache"),
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    };
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function setup(name: string) {
    const rulesDir = join(root, name, "rules");
    const dataDir = join(root, name, "data");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, "package.json"),
      JSON.stringify({
        name: "my-rules",
        private: true,
        dependencies: { greeter: `file:${tarball}` },
      }),
    );
    return { rulesDir, dataDir };
  }

  it("installs a dependency from package.json so a rule file can import it", async () => {
    const { rulesDir, dataDir } = setup("install");
    writeFileSync(
      join(rulesDir, "hello.ts"),
      'import { greet } from "greeter";\nimport { rule } from "@home-engine/sdk";\nrule(greet("rules"), { kind: "startup" }, () => {});\n',
    );
    const capture = logCapture([]);
    expect(await installRuleDependencies({ rulesDir, dataDir, log: capture.log, env })).toBe(
      "installed",
    );

    const registry = new RuleRegistry({ sources: new FakeSources().sources, log: capture.log });
    const loader = new RuleLoader({
      rulesDir,
      buildDir: join(dataDir, ".build"),
      registry,
      log: capture.log,
    });
    await loader.loadAll();
    expect(registry.listRules().map((r) => r.name)).toEqual(["hello rules"]);
    await registry.unloadAll();
  }, 60_000);

  it("skips the installation when package.json and the lockfile are unchanged", async () => {
    const { rulesDir, dataDir } = setup("skip");
    const log = logCapture([]).log;
    expect(await installRuleDependencies({ rulesDir, dataDir, log, env })).toBe("installed");
    expect(await installRuleDependencies({ rulesDir, dataDir, log, env })).toBe("unchanged");

    writeFileSync(
      join(rulesDir, "package.json"),
      JSON.stringify({
        name: "my-rules",
        private: true,
        version: "2.0.0",
        dependencies: { greeter: `file:${tarball}` },
      }),
    );
    expect(await installRuleDependencies({ rulesDir, dataDir, log, env })).toBe("installed");
  }, 60_000);

  it("uses npm ci when the rules directory has a lockfile", async () => {
    const { rulesDir, dataDir } = setup("lockfile");
    const capture = logCapture([]);
    capture.log.level = "debug";
    expect(await installRuleDependencies({ rulesDir, dataDir, log: capture.log, env })).toBe(
      "installed",
    );
    copyFileSync(join(dataDir, "deps", "package-lock.json"), join(rulesDir, "package-lock.json"));
    expect(await installRuleDependencies({ rulesDir, dataDir, log: capture.log, env })).toBe(
      "installed",
    );
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({ command: "npm ci --omit=dev --no-audit --no-fund" }),
    );
    expect(await installRuleDependencies({ rulesDir, dataDir, log: capture.log, env })).toBe(
      "unchanged",
    );
  }, 60_000);

  it("works with a read-only rules directory", async () => {
    const { rulesDir, dataDir } = setup("readonly");
    chmodSync(rulesDir, 0o555);
    try {
      expect(
        await installRuleDependencies({ rulesDir, dataDir, log: logCapture([]).log, env }),
      ).toBe("installed");
    } finally {
      chmodSync(rulesDir, 0o755);
    }
  }, 60_000);

  it("logs the installer output and carries on when installation fails", async () => {
    const { rulesDir, dataDir } = setup("failing");
    writeFileSync(
      join(rulesDir, "package.json"),
      JSON.stringify({
        name: "my-rules",
        private: true,
        dependencies: { "does-not-exist-anywhere": "1.0.0" },
      }),
    );
    const capture = logCapture([]);
    expect(await installRuleDependencies({ rulesDir, dataDir, log: capture.log, env })).toBe(
      "failed",
    );
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringMatching(/^Installing rule dependencies failed/),
        stderr: expect.any(String),
      }),
    );

    // The engine still loads the rule files; one importing the missing package fails alone.
    writeFileSync(
      join(rulesDir, "plain.ts"),
      'import { rule } from "@home-engine/sdk";\nrule("plain", { kind: "startup" }, () => {});\n',
    );
    writeFileSync(
      join(rulesDir, "needs-package.ts"),
      'import { thing } from "does-not-exist-anywhere";\nimport { rule } from "@home-engine/sdk";\nrule(String(thing), { kind: "startup" }, () => {});\n',
    );
    const registry = new RuleRegistry({ sources: new FakeSources().sources, log: capture.log });
    const loader = new RuleLoader({
      rulesDir,
      buildDir: join(dataDir, ".build"),
      registry,
      log: capture.log,
    });
    await loader.loadAll();
    expect(registry.listRules().map((r) => r.id)).toEqual(["plain#plain"]);
    expect(registry.listFiles().find((f) => f.file === "needs-package.ts")).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/does-not-exist-anywhere/),
    });
    await registry.unloadAll();
  }, 60_000);

  it("does nothing without package.json or with NPM_INSTALL=false", async () => {
    const empty = join(root, "none");
    mkdirSync(empty, { recursive: true });
    const log = logCapture([]).log;
    expect(
      await installRuleDependencies({ rulesDir: empty, dataDir: join(root, "none-data"), log }),
    ).toBe("no-manifest");
    const { rulesDir, dataDir } = setup("disabled");
    expect(await installRuleDependencies({ rulesDir, dataDir, log, enabled: false })).toBe(
      "disabled",
    );
  });
});
