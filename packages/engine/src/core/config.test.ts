import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  redact,
  valueOrFile,
  type ConfigProblem,
  type Env,
} from "./config.js";

const noBackend = (): Record<string, never> => ({});
const anyDir = { checkRulesDir: () => undefined };

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.problems.map((p) => p.message);
    throw err;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig: core variables", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "he-config-"));
  });

  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies defaults", () => {
    const { core } = loadConfig({}, noBackend, anyDir);
    expect(core).toEqual({
      rulesDir: "/rules",
      dataDir: "/data",
      logLevel: "info",
      logFormat: "pretty",
      hotReload: true,
      watchPoll: "auto",
      disabledRules: [],
      dryRun: false,
      timeZone: undefined,
      httpPort: 8080,
      npmInstall: true,
    });
  });

  it("reads every variable", () => {
    const env: Env = {
      RULES_DIR: dir,
      DATA_DIR: "/srv/data",
      LOG_LEVEL: "DEBUG",
      LOG_FORMAT: "json",
      HOT_RELOAD: "false",
      WATCH_POLL: "true",
      DRY_RUN: "1",
      TIME_ZONE: "Europe/Berlin",
      HTTP_PORT: "0",
      NPM_INSTALL: "no",
    };
    expect(loadConfig(env, noBackend).core).toMatchObject({
      rulesDir: dir,
      dataDir: "/srv/data",
      logLevel: "debug",
      logFormat: "json",
      hotReload: false,
      watchPoll: "true",
      dryRun: true,
      timeZone: "Europe/Berlin",
      httpPort: 0,
      npmInstall: false,
    });
  });

  it("treats empty variables as unset", () => {
    expect(loadConfig({ LOG_LEVEL: "", HTTP_PORT: " " }, noBackend, anyDir).core).toMatchObject({
      logLevel: "info",
      httpPort: 8080,
    });
  });

  it("parses the disabled rules list, ignoring surrounding whitespace", () => {
    const { core } = loadConfig(
      { DISABLED_RULES: "lights/*, climate#heating ,," },
      noBackend,
      anyDir,
    );
    expect(core.disabledRules).toEqual(["lights/*", "climate#heating"]);
  });

  it("reports several problems at once", () => {
    const problems = problemsOf(() =>
      loadConfig({ LOG_LEVEL: "verbose", HTTP_PORT: "abc" }, noBackend, anyDir),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/LOG_LEVEL: "verbose" is not valid/);
    expect(problems[1]).toMatch(/HTTP_PORT: "abc" is not a port/);
  });

  it.each([
    ["LOG_FORMAT", "xml", /LOG_FORMAT/],
    ["WATCH_POLL", "sometimes", /WATCH_POLL/],
    ["HOT_RELOAD", "maybe", /HOT_RELOAD: "maybe" is not a boolean/],
    ["HTTP_PORT", "70000", /HTTP_PORT/],
    ["HTTP_PORT", "-1", /HTTP_PORT/],
    ["TIME_ZONE", "Mars/Olympus", /TIME_ZONE/],
  ])("rejects %s=%s", (name, val, message) => {
    expect(problemsOf(() => loadConfig({ [name]: val }, noBackend, anyDir))).toEqual([
      expect.stringMatching(message),
    ]);
  });

  it("includes the backend's problems", () => {
    const backend = (): ConfigProblem[] => [{ message: "HA_TOKEN is required" }];
    expect(problemsOf(() => loadConfig({ LOG_LEVEL: "x" }, backend, anyDir))).toEqual([
      expect.stringMatching(/LOG_LEVEL/),
      "HA_TOKEN is required",
    ]);
  });

  it("reports a missing rules directory", () => {
    const missing = join(dir, "nope");
    expect(problemsOf(() => loadConfig({ RULES_DIR: missing }, noBackend))).toEqual([
      `RULES_DIR: directory ${missing} does not exist.`,
    ]);
  });

  it("reports a rules path that is a file", () => {
    const file = join(dir, "file");
    writeFileSync(file, "");
    expect(problemsOf(() => loadConfig({ RULES_DIR: file }, noBackend))).toEqual([
      `RULES_DIR: ${file} is not a directory.`,
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("reports an unreadable rules directory", () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(problemsOf(() => loadConfig({ RULES_DIR: locked }, noBackend))).toEqual([
        `RULES_DIR: directory ${locked} is not readable.`,
      ]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("accepts an empty rules directory", () => {
    expect(loadConfig({ RULES_DIR: dir }, noBackend).core.rulesDir).toBe(dir);
  });
});

describe("valueOrFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "he-secret-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the trimmed file content", () => {
    const file = join(dir, "token");
    writeFileSync(file, "secret-token\n");
    const problems: ConfigProblem[] = [];
    expect(valueOrFile({ X_FILE: file }, "X", problems)).toBe("secret-token");
    expect(problems).toEqual([]);
  });

  it("rejects setting both variants, naming both", () => {
    const problems: ConfigProblem[] = [];
    expect(valueOrFile({ X: "a", X_FILE: "/f" }, "X", problems)).toBeUndefined();
    expect(problems).toEqual([{ message: "X and X_FILE are both set; set only one of them." }]);
  });

  it("reports an unreadable or empty file", () => {
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n");
    const problems: ConfigProblem[] = [];
    valueOrFile({ X_FILE: join(dir, "missing") }, "X", problems);
    valueOrFile({ X_FILE: empty }, "X", problems);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/X_FILE: cannot read .*missing \(ENOENT\)/),
      expect.stringMatching(/X_FILE: file .*empty is empty/),
    ]);
  });
});

describe("redact", () => {
  it("replaces secret-looking keys at any depth and keeps everything else", () => {
    expect(
      redact({
        token: "a",
        nested: { accessToken: "b", list: [{ password: "c", name: "x" }], apiKey: "d" },
        port: 8080,
        missingToken: undefined,
      }),
    ).toEqual({
      token: "***",
      nested: { accessToken: "***", list: [{ password: "***", name: "x" }], apiKey: "***" },
      port: 8080,
      missingToken: undefined,
    });
  });
});
