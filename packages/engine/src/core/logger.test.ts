import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { LogFormat, LogLevel } from "./config.js";
import { createLogger, ruleLogger } from "./logger.js";

function capture(): {
  stream: Writable;
  text: () => string;
  lines: () => Array<Record<string, unknown>>;
} {
  let out = "";
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  return {
    stream,
    text: () => out,
    lines: () =>
      out
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function setup(level: LogLevel = "info", format: LogFormat = "json", secrets: string[] = []) {
  const out = capture();
  const log = createLogger({ level, format, secrets, destination: out.stream, colorize: false });
  return { log, ...out };
}

describe("logger", () => {
  it("writes one JSON object per line with timestamp, level, message, source and fields", () => {
    const { log, lines, text } = setup();
    ruleLogger(log, "lights#porch").info({ entity: "light.porch" }, "turned on");

    expect(text().trimEnd().split("\n")).toHaveLength(1);
    const [entry] = lines();
    expect(entry).toMatchObject({
      level: "info",
      message: "turned on",
      source: "lights#porch",
      entity: "light.porch",
    });
    expect(entry?.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("tags engine messages with source engine", () => {
    const { log, lines } = setup();
    log.info("connected");
    expect(lines()[0]).toMatchObject({ source: "engine", message: "connected" });
  });

  it("emits only messages at or above the configured level", () => {
    const { log, lines } = setup("info");
    const rule = ruleLogger(log, "climate#heating");
    rule.trace("t");
    rule.debug("d");
    rule.info("i");
    rule.warn("w");
    rule.error("e");
    rule.fatal("f");
    expect(lines().map((l) => l.level)).toEqual(["info", "warn", "error", "fatal"]);
  });

  it("supports every level down to trace", () => {
    const { log, lines } = setup("trace");
    log.trace("t");
    log.debug("d");
    expect(lines().map((l) => l.level)).toEqual(["trace", "debug"]);
  });

  it("identifies the rule as source in pretty output", () => {
    const { log, text } = setup("info", "pretty");
    ruleLogger(log, "climate#heating").info({ target: 21 }, "boost started");
    expect(text()).toMatch(/INFO.*\[climate#heating\] boost started/);
    expect(text()).toContain("target: 21");
  });

  it("never writes a known secret, at any level, in either format", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.secret-token-value";
    for (const format of ["json", "pretty"] as const) {
      const { log, text } = setup("trace", format, [token]);
      log.trace({ token }, "auth with token field");
      log.debug({ headers: { Authorization: `Bearer ${token}` } }, "request");
      log.info(`token in message: ${token}`);
      log.error(new Error(`failed with ${token}`), "auth failed");
      expect(text()).not.toContain(token);
      expect(text()).toContain("***");
    }
  });

  it("redacts secret-looking keys even when the value is not a registered secret", () => {
    const { log, lines } = setup();
    log.info({ config: { backend: { token: "unregistered" } }, password: "pw" }, "x");
    expect(lines()[0]).toMatchObject({ config: { backend: { token: "***" } }, password: "***" });
  });
});
