import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type Env } from "../../core/config.js";
import { readHomeAssistantConfig } from "./config.js";

const anyDir = { checkRulesDir: () => undefined };

function load(env: Env) {
  return loadConfig(env, readHomeAssistantConfig, anyDir);
}

function problemsOf(env: Env): string[] {
  try {
    load(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems.map((p) => p.message);
    throw err;
  }
  throw new Error("expected a ConfigError");
}

describe("Home Assistant config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "he-ha-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies the documented defaults when only HA_URL and HA_TOKEN are set", () => {
    const { core, backend } = load({ HA_URL: "http://homeassistant.local:8123", HA_TOKEN: "t" });
    expect(core).toMatchObject({
      rulesDir: "/rules",
      dataDir: "/data",
      logLevel: "info",
      logFormat: "pretty",
      httpPort: 8080,
    });
    expect(backend).toEqual({
      baseUrl: "http://homeassistant.local:8123",
      wsUrl: "ws://homeassistant.local:8123/api/websocket",
      restUrl: "http://homeassistant.local:8123/api",
      token: "t",
      supervisor: false,
    });
  });

  it.each([
    ["http://homeassistant.local:8123", "ws://homeassistant.local:8123/api/websocket"],
    ["https://ha.example.com", "wss://ha.example.com/api/websocket"],
    ["https://ha.example.com/", "wss://ha.example.com/api/websocket"],
    ["https://proxy.example.com/ha/", "wss://proxy.example.com/ha/api/websocket"],
  ])("converts %s to %s", (url, wsUrl) => {
    expect(load({ HA_URL: url, HA_TOKEN: "t" }).backend.wsUrl).toBe(wsUrl);
  });

  it.each(["homeassistant.local:8123", "not a url", "ftp://ha", "http://u:p@ha:8123"])(
    "rejects malformed HA_URL %s",
    (url) => {
      expect(problemsOf({ HA_URL: url, HA_TOKEN: "t" })).toEqual([
        expect.stringMatching(/^HA_URL: /),
      ]);
    },
  );

  it("reads the token from a Docker secret file without the trailing newline", () => {
    const file = join(dir, "ha_token");
    writeFileSync(file, "abc123\n");
    expect(load({ HA_URL: "http://ha:8123", HA_TOKEN_FILE: file }).backend.token).toBe("abc123");
  });

  it("reads HA_URL from a file too", () => {
    const file = join(dir, "ha_url");
    writeFileSync(file, "http://ha:8123\n");
    expect(load({ HA_URL_FILE: file, HA_TOKEN: "t" }).backend.wsUrl).toBe(
      "ws://ha:8123/api/websocket",
    );
  });

  it("fails when both HA_TOKEN and HA_TOKEN_FILE are set, naming both", () => {
    const problems = problemsOf({ HA_URL: "http://ha:8123", HA_TOKEN: "t", HA_TOKEN_FILE: "/x" });
    expect(problems).toEqual(["HA_TOKEN and HA_TOKEN_FILE are both set; set only one of them."]);
  });

  it("requires HA_TOKEN when neither it, its file variant nor SUPERVISOR_TOKEN is set", () => {
    expect(problemsOf({ HA_URL: "http://ha:8123" })).toEqual([
      expect.stringMatching(/^HA_TOKEN is required/),
    ]);
  });

  it("requires HA_URL and HA_TOKEN without Supervisor", () => {
    expect(problemsOf({})).toEqual([
      expect.stringMatching(/^HA_URL is required/),
      expect.stringMatching(/^HA_TOKEN is required/),
    ]);
  });

  it("reports core and Home Assistant problems together", () => {
    expect(problemsOf({ LOG_LEVEL: "verbose", HTTP_PORT: "abc", HA_URL: "nope" })).toHaveLength(4);
  });

  it("connects through the Supervisor when SUPERVISOR_TOKEN is set and HA_URL/HA_TOKEN are not", () => {
    expect(load({ SUPERVISOR_TOKEN: "sup" }).backend).toEqual({
      baseUrl: "http://supervisor/core",
      wsUrl: "ws://supervisor/core/websocket",
      restUrl: "http://supervisor/core/api",
      token: "sup",
      supervisor: true,
    });
  });

  it("prefers explicit HA_URL and HA_TOKEN over the Supervisor", () => {
    const { backend } = load({
      SUPERVISOR_TOKEN: "sup",
      HA_URL: "http://ha:8123",
      HA_TOKEN: "mine",
    });
    expect(backend).toMatchObject({
      wsUrl: "ws://ha:8123/api/websocket",
      token: "mine",
      supervisor: false,
    });
  });
});
