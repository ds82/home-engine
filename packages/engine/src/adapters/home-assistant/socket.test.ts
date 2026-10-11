import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FatalError } from "../../core/errors.js";
import { createLogger } from "../../core/logger.js";
import type { HomeAssistantConfig } from "./config.js";
import {
  AuthInvalidError,
  ConnectError,
  connectAtStartup,
  openAuthenticatedSocket,
} from "./socket.js";
import { MockHomeAssistant } from "./testing/mock-server.js";

const TOKEN = "eyJ0eXAiOiJKV1Qi.long-lived-token-abc123";

function logCapture(secrets: string[] = [TOKEN]) {
  let out = "";
  const destination = new Writable({
    write(chunk: Buffer | string, _e, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const log = createLogger({ level: "trace", format: "json", secrets, destination });
  return {
    log,
    text: () => out,
    entries: () =>
      out
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("Home Assistant auth handshake", () => {
  let ha: MockHomeAssistant;
  let config: HomeAssistantConfig;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN], version: "2026.10.1" });
    await ha.start();
    config = {
      baseUrl: ha.url,
      wsUrl: ha.wsUrl,
      restUrl: `${ha.url}/api`,
      token: TOKEN,
      supervisor: false,
    };
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await ha.stop();
  });

  it("authenticates on auth_ok and logs the Home Assistant version", async () => {
    const { log, entries } = logCapture();
    const { ws, haVersion } = await connectAtStartup(config, log);
    sockets.push(ws);
    expect(haVersion).toBe("2026.10.1");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(ha.connectionCount).toBe(1);
    expect(entries()).toContainEqual(
      expect.objectContaining({ level: "info", message: "Connected to Home Assistant 2026.10.1" }),
    );
  });

  it("fails fatally with a non-zero exit code on auth_invalid at startup, without logging the token", async () => {
    const { log, text, entries } = logCapture(["wrong-token-xyz"]);
    const err = await connectAtStartup({ ...config, token: "wrong-token-xyz" }, log).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FatalError);
    expect((err as FatalError).exitCode).not.toBe(0);
    expect((err as FatalError).cause).toBeInstanceOf(AuthInvalidError);
    expect(entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringMatching(/Authentication .* failed/),
      }),
    );
    expect(text()).not.toContain("wrong-token-xyz");
  });

  it("never logs the token, even at trace level", async () => {
    const { log, text } = logCapture();
    const { ws } = await openAuthenticatedSocket({ wsUrl: ha.wsUrl, token: TOKEN, log });
    sockets.push(ws);
    expect(text()).toContain('"type":"auth"');
    expect(text()).not.toContain(TOKEN);
  });

  it("treats an unreachable Home Assistant as a non-fatal connect error", async () => {
    const { log } = logCapture();
    await ha.stop();
    const err = await connectAtStartup(config, log).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err).not.toBeInstanceOf(FatalError);
  });

  it("times out when Home Assistant never sends auth_required", async () => {
    const { log } = logCapture();
    const { WebSocketServer } = await import("ws");
    const silent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => silent.once("listening", r));
    const port = (silent.address() as { port: number }).port;
    try {
      const err = await openAuthenticatedSocket({
        wsUrl: `ws://127.0.0.1:${port}`,
        token: TOKEN,
        log,
        timeoutMs: 100,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as Error).message).toMatch(/Timed out/);
    } finally {
      for (const c of silent.clients) c.terminate();
      await new Promise((r) => silent.close(r));
    }
  });

  it("can be aborted", async () => {
    const { log } = logCapture();
    const controller = new AbortController();
    const pending = openAuthenticatedSocket({
      wsUrl: ha.wsUrl,
      token: TOKEN,
      log,
      signal: controller.signal,
    });
    controller.abort(new Error("shutting down"));
    await expect(pending).rejects.toThrow("shutting down");
  });
});
