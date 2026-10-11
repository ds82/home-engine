import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleScopeImpl } from "../../core/rule-scope.js";
import { invoke } from "../../core/run-context.js";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { HaCommandError } from "./session.js";
import type { HaEvent } from "./subscriptions.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { createWrites, NotConnectedError, type Writes } from "./writes.js";

describe("fire, raw WebSocket access and connection status", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let writes: Writes;
  let scope: RuleScopeImpl;
  let delay: FakeDelay;

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    await ha.start();
    delay = new FakeDelay();
    client = new HaClient(
      {
        baseUrl: ha.url,
        wsUrl: ha.wsUrl,
        restUrl: `${ha.url}/api`,
        token: TOKEN,
        supervisor: false,
      },
      logCapture([]).log,
      { delay: delay.delay, random: () => 1 },
    );
    await client.start();
    writes = createWrites(client, logCapture([]).log);
    scope = new RuleScopeImpl("alerts#rule", logCapture([]).log);
  });

  afterEach(async () => {
    await scope.dispose();
    await client.stop();
    await ha.stop();
  });

  async function inRule<T>(fn: () => T | Promise<T>): Promise<{ value?: T; error?: unknown }> {
    const out: { value?: T; error?: unknown } = {};
    await invoke(scope, "body", async () => {
      try {
        out.value = await fn();
      } catch (err) {
        out.error = err;
      }
    }).done;
    return out;
  }

  const flush = async (): Promise<void> => {
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
  };

  describe("fire", () => {
    it("fires a custom event that listeners on the bus receive with its data", async () => {
      const received: HaEvent[] = [];
      client.subscriptions.onEvent("home_engine_alert", (e) => received.push(e));
      await flush();
      const { error } = await inRule(() => writes.fire("home_engine_alert", { level: "high" }));
      await flush();
      expect(error).toBeUndefined();
      expect(received.map((e) => e.data)).toEqual([{ level: "high" }]);
      expect(ha.received.at(-2)).toMatchObject({
        type: "fire_event",
        event_type: "home_engine_alert",
      });
    });

    it("rejects data that is not JSON-serialisable at the call site", async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const { error } = await inRule(() => writes.fire("home_engine_alert", circular));
      expect((error as Error).message).toMatch(/JSON-serialisable/);
    });

    it("rejects promptly while disconnected", async () => {
      await ha.stop();
      await delay.next();
      const { error } = await inRule(() => writes.fire("home_engine_alert"));
      expect(error).toBeInstanceOf(NotConnectedError);
    });
  });

  describe("ws.command", () => {
    it("sends arbitrary commands and resolves with their result", async () => {
      const registry = [{ entity_id: "light.kitchen", platform: "hue" }];
      ha.onCommand("config/entity_registry/list", () => ({ result: registry }));
      const { value } = await inRule(() =>
        writes.ws.command({ type: "config/entity_registry/list" }),
      );
      expect(value).toEqual(registry);
    });

    it("rejects with Home Assistant's error for unsupported commands", async () => {
      const { error } = await inRule(() => writes.ws.command({ type: "does/not/exist" }));
      expect(error).toBeInstanceOf(HaCommandError);
      expect(error).toMatchObject({ code: "unknown_command" });
    });
  });

  describe("connection", () => {
    async function reconnect(): Promise<void> {
      const ready = new Promise<void>((r) => {
        const off = client.onReady(() => {
          off();
          r();
        });
      });
      ha.dropConnections();
      await delay.elapseNext();
      await ready;
      await new Promise((r) => setImmediate(r));
    }

    it("reports the status and notifies disconnects once and reconnects", async () => {
      const events: string[] = [];
      await inRule(() => {
        expect(writes.connection.isConnected()).toBe(true);
        writes.connection.onDisconnect(() => void events.push("down"));
        writes.connection.onConnect(() => void events.push("up"));
      });
      await reconnect();
      expect(events).toEqual(["down", "up"]);
    });

    it("stops notifying cancelled handles and unloaded rules", async () => {
      const events: string[] = [];
      await inRule(() => {
        writes.connection.onDisconnect(() => void events.push("cancelled")).cancel();
        writes.connection.onDisconnect(() => void events.push("unloaded"));
      });
      await scope.dispose();
      await reconnect();
      expect(events).toEqual([]);
    });

    it("needs rule code for notifications", () => {
      expect(() => writes.connection.onDisconnect(() => {})).toThrow(
        /must be called from rule code/,
      );
    });
  });
});
