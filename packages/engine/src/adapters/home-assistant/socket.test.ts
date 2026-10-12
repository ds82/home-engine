import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthInvalidError, ConnectError, openAuthenticatedSocket } from "./socket.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { TOKEN, logCapture } from "../../core/testing/log-capture.js";

describe("Home Assistant auth handshake", () => {
  let ha: MockHomeAssistant;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN], version: "2026.10.1" });
    await ha.start();
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      ws.close();
    }
    await ha.stop();
  });

  it("resolves with the open socket and Home Assistant version on auth_ok", async () => {
    const { log } = logCapture();
    const { ws, haVersion } = await openAuthenticatedSocket({ wsUrl: ha.wsUrl, token: TOKEN, log });
    sockets.push(ws);
    expect(haVersion).toBe("2026.10.1");
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects with AuthInvalidError on auth_invalid", async () => {
    const { log } = logCapture();
    await expect(
      openAuthenticatedSocket({ wsUrl: ha.wsUrl, token: "wrong", log }),
    ).rejects.toBeInstanceOf(AuthInvalidError);
  });

  it("never logs the token, even at trace level", async () => {
    const { log, text } = logCapture();
    const { ws } = await openAuthenticatedSocket({ wsUrl: ha.wsUrl, token: TOKEN, log });
    sockets.push(ws);
    expect(text()).toContain('"type":"auth"');
    expect(text()).not.toContain(TOKEN);
  });

  it("rejects with ConnectError when Home Assistant is unreachable", async () => {
    const { log } = logCapture();
    await ha.stop();
    await expect(
      openAuthenticatedSocket({ wsUrl: ha.wsUrl, token: TOKEN, log }),
    ).rejects.toBeInstanceOf(ConnectError);
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
      for (const c of silent.clients) {
        c.terminate();
      }
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
