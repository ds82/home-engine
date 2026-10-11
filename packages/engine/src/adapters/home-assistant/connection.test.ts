import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FatalError } from "../../core/errors.js";
import type { HomeAssistantConfig } from "./config.js";
import { BACKOFF_MAX_MS, HaConnection, backoffDelay } from "./connection.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { TOKEN, logCapture } from "../../core/testing/log-capture.js";
import { MockHomeAssistant } from "./testing/mock-server.js";

describe("backoffDelay", () => {
  it("starts at 1 s, doubles and caps at 60 s", () => {
    const noJitter = (): number => 1;
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((a) => backoffDelay(a, noJitter))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("applies up to 20 % jitter downwards and never exceeds the cap", () => {
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(Infinity, () => 0)).toBe(48_000);
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(10);
      expect(d).toBeGreaterThanOrEqual(48_000);
      expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    }
  });
});

describe("HaConnection", () => {
  let ha: MockHomeAssistant;
  let config: HomeAssistantConfig;
  let fake: FakeDelay;
  let conn: HaConnection | undefined;

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
    fake = new FakeDelay();
  });

  afterEach(async () => {
    await conn?.stop();
    conn = undefined;
    await ha.stop();
  });

  function connect(overrides: Partial<HomeAssistantConfig> = {}, log = logCapture().log) {
    conn = new HaConnection({
      config: { ...config, ...overrides },
      log,
      delay: fake.delay,
      random: () => 1,
      connectTimeoutMs: 2_000,
    });
    return conn;
  }

  it("connects, logs the version and hands out a session", async () => {
    const capture = logCapture();
    const c = connect({}, capture.log);
    const sessions: Array<{ reconnect: boolean }> = [];
    c.onSession((_s, info) => sessions.push(info));
    await c.start();
    expect(c.current?.isOpen).toBe(true);
    expect(c.version).toBe("2026.10.1");
    expect(sessions).toEqual([{ haVersion: "2026.10.1", reconnect: false }]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({ level: "info", message: "Connected to Home Assistant 2026.10.1" }),
    );
  });

  it("waits for Home Assistant at startup, retrying with increasing delays", async () => {
    await ha.stop();
    const c = connect();
    let started = false;
    const starting = c.start().then(() => (started = true));

    expect(await fake.elapseNext()).toBe(1_000);
    expect(await fake.elapseNext()).toBe(2_000);
    const third = await fake.next();
    expect(third.ms).toBe(4_000);
    expect(started).toBe(false);

    await ha.start();
    third.release();
    await starting;
    expect(c.current?.isOpen).toBe(true);
  });

  it("fails fatally with a non-zero exit code on auth_invalid at startup, without logging the token", async () => {
    const capture = logCapture(["wrong-token-xyz"]);
    const err = await connect({ token: "wrong-token-xyz" }, capture.log)
      .start()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect((err as FatalError).exitCode).not.toBe(0);
    expect(fake.requested).toEqual([]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringMatching(/check HA_TOKEN/) }),
    );
    expect(capture.text()).not.toContain("wrong-token-xyz");
  });

  it("reconnects after Home Assistant restarts, without restarting the process", async () => {
    const c = connect();
    const sessions: boolean[] = [];
    let disconnects = 0;
    c.onSession((_s, info) => sessions.push(info.reconnect));
    c.onDisconnect(() => disconnects++);
    await c.start();

    await ha.stop();
    expect(await fake.elapseNext()).toBe(1_000);
    expect(await fake.elapseNext()).toBe(2_000);
    const pending = await fake.next();
    await ha.start();
    const reconnected = new Promise<void>((r) => c.onSession(() => r()));
    pending.release();
    await reconnected;

    expect(sessions).toEqual([false, true]);
    expect(disconnects).toBe(1);
    expect(c.current?.isOpen).toBe(true);
  });

  it("resets the backoff after a successful connection", async () => {
    const c = connect();
    await c.start();
    for (let round = 0; round < 2; round++) {
      const reconnected = new Promise<void>((r) => {
        const off = c.onSession(() => {
          off();
          r();
        });
      });
      ha.dropConnections();
      expect(await fake.elapseNext()).toBe(1_000);
      await reconnected;
    }
    expect(fake.requested).toEqual([1_000, 1_000]);
  });

  it("keeps retrying at the maximum delay when the token becomes invalid later", async () => {
    const capture = logCapture();
    const c = connect({}, capture.log);
    await c.start();

    ha.setTokens(["rotated"]);
    ha.dropConnections();
    expect(await fake.elapseNext()).toBe(1_000);
    expect(await fake.elapseNext()).toBe(BACKOFF_MAX_MS);
    const pending = await fake.next();
    expect(pending.ms).toBe(BACKOFF_MAX_MS);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringMatching(/rejected the access token on reconnect/),
      }),
    );

    ha.setTokens([TOKEN]);
    const reconnected = new Promise<void>((r) => c.onSession(() => r()));
    pending.release();
    await reconnected;
    expect(c.current?.isOpen).toBe(true);
  });

  it("stops reconnecting after stop()", async () => {
    const c = connect();
    await c.start();
    await ha.stop();
    await fake.next();
    await c.stop();
    expect(c.current).toBeUndefined();
    const before = fake.requested.length;
    await ha.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.requested.length).toBe(before);
  });

  it("rejects start() when stopped before the first connection", async () => {
    await ha.stop();
    const c = connect();
    const starting = c.start();
    await fake.next();
    await c.stop();
    await expect(starting).rejects.toThrow(/stopped/);
  });

  it("reconnects when Home Assistant stops answering pings", async () => {
    const capture = logCapture();
    conn = new HaConnection({
      config,
      log: capture.log,
      delay: fake.delay,
      random: () => 1,
      pingIntervalMs: 20,
      pongTimeoutMs: 50,
    });
    const c = conn;
    let disconnects = 0;
    c.onDisconnect(() => disconnects++);
    await c.start();
    const first = c.current;

    ha.respondToPing = false;
    const backoff = await fake.next();
    expect(disconnects).toBe(1);
    expect(first?.isOpen).toBe(false);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringMatching(/did not answer a ping/),
      }),
    );

    ha.respondToPing = true;
    const reconnected = new Promise<void>((r) => c.onSession(() => r()));
    backoff.release();
    await reconnected;
    expect(c.current).not.toBe(first);
    expect(c.current?.isOpen).toBe(true);
  });

  it("keeps a healthy connection open while pings are answered", async () => {
    conn = new HaConnection({
      config,
      log: logCapture().log,
      delay: fake.delay,
      pingIntervalMs: 10,
      pongTimeoutMs: 200,
    });
    await conn.start();
    const session = conn.current;
    await new Promise((r) => setTimeout(r, 120));
    expect(conn.current).toBe(session);
    expect(ha.received.filter((m) => m.type === "ping").length).toBeGreaterThanOrEqual(3);
    expect(fake.requested).toEqual([]);
  });
});
