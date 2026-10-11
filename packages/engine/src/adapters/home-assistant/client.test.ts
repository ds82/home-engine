import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HaClient } from "./client.js";
import type { StateChange } from "./state-cache.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { TOKEN, logCapture } from "./testing/log-capture.js";
import { MockHomeAssistant } from "./testing/mock-server.js";

describe("HaClient state cache", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let fake: FakeDelay;
  let changes: StateChange[];

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    await ha.start();
    fake = new FakeDelay();
    client = new HaClient(
      {
        baseUrl: ha.url,
        wsUrl: ha.wsUrl,
        restUrl: `${ha.url}/api`,
        token: TOKEN,
        supervisor: false,
      },
      logCapture().log,
      { delay: fake.delay, random: () => 1 },
    );
    changes = [];
    client.states.onChange((c) => changes.push(c));
  });

  afterEach(async () => {
    await client.stop();
    await ha.stop();
  });

  async function flush(): Promise<void> {
    await client.connection.current?.command({ type: "ping" });
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Simulates a Home Assistant restart; `whileDown` changes states without events. */
  async function restart(whileDown: () => void): Promise<void> {
    await ha.stop();
    const backoff = await fake.next();
    whileDown();
    await ha.start();
    const ready = new Promise<void>((r) => {
      const off = client.onReady(() => {
        off();
        r();
      });
    });
    backoff.release();
    await ready;
  }

  it("is populated from get_states at startup, without change events", async () => {
    ha.setState("light.kitchen", "on", { brightness: 100 });
    ha.setState("sensor.temp", "21.5");
    await client.start();
    expect(client.isReady).toBe(true);
    expect(client.states.get("light.kitchen")).toMatchObject({
      state: "on",
      attributes: { brightness: 100 },
    });
    expect(client.states.size).toBe(2);
    expect(changes).toEqual([]);
  });

  it("stays current from state_changed events, including creation and removal", async () => {
    ha.setState("light.kitchen", "off");
    await client.start();
    ha.setState("light.kitchen", "on");
    ha.setState("sensor.new_one", "1");
    ha.removeState("light.kitchen");
    await flush();

    expect(client.states.get("light.kitchen")).toBeUndefined();
    expect(client.states.get("sensor.new_one")?.state).toBe("1");
    expect(
      changes.map((c) => [c.entityId, c.oldState?.state, c.newState?.state, c.resynced]),
    ).toEqual([
      ["light.kitchen", "off", "on", false],
      ["sensor.new_one", undefined, "1", false],
      ["light.kitchen", "on", undefined, false],
    ]);
    expect(changes[0]?.context?.id).toEqual(expect.any(String));
  });

  it("keeps the last known states while disconnected and refreshes them after reconnect", async () => {
    ha.setState("sensor.temp", "20");
    await client.start();
    await ha.stop();
    const backoff = await fake.next();
    expect(client.isReady).toBe(false);
    expect(client.states.get("sensor.temp")?.state).toBe("20");

    ha.setState("sensor.temp", "23", undefined, { silent: true });
    await ha.start();
    const ready = new Promise<void>((r) => client.onReady(r));
    backoff.release();
    await ready;
    expect(client.states.get("sensor.temp")?.state).toBe("23");
  });

  it("delivers one resynced event for a door opened during a Home Assistant restart", async () => {
    ha.setState("binary_sensor.front_door", "off");
    await client.start();

    await restart(() => ha.setState("binary_sensor.front_door", "on", undefined, { silent: true }));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      entityId: "binary_sensor.front_door",
      oldState: { state: "off" },
      newState: { state: "on" },
      resynced: true,
      context: undefined,
    });
  });

  it("delivers nothing for an entity that changed and changed back while disconnected", async () => {
    ha.setState("switch.pump", "off");
    await client.start();
    await restart(() => {
      ha.setState("switch.pump", "on", undefined, { silent: true });
      ha.setState("switch.pump", "off", undefined, { silent: true });
    });
    expect(changes).toEqual([]);
  });

  it("reports attribute differences and entities that appeared or disappeared", async () => {
    ha.setState("light.hall", "on", { brightness: 100 });
    ha.setState("sensor.old", "1");
    await client.start();

    await restart(() => {
      ha.setState("light.hall", "on", { brightness: 200 }, { silent: true });
      ha.removeState("sensor.old", { silent: true });
      ha.setState("sensor.fresh", "5", undefined, { silent: true });
    });

    const summary = changes
      .map((c) => [c.entityId, c.oldState?.state, c.newState?.state, c.resynced])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(summary).toEqual([
      ["light.hall", "on", "on", true],
      ["sensor.fresh", undefined, "5", true],
      ["sensor.old", "1", undefined, true],
    ]);
  });

  it("replays subscriptions before loading states on reconnect", async () => {
    await client.start();
    client.subscriptions.onEvent("zha_event", () => {});
    await flush();
    const from = ha.received.length;
    await restart(() => {});
    const types = ha.received.slice(from).map((m) => m.type);
    const lastSubscribe = types.lastIndexOf("subscribe_events");
    expect(types.filter((t) => t === "subscribe_events")).toHaveLength(2);
    expect(lastSubscribe).toBeLessThan(types.indexOf("get_states"));
  });

  it("receives live changes again after a reconnect", async () => {
    ha.setState("light.kitchen", "off");
    await client.start();
    await restart(() => {});
    ha.setState("light.kitchen", "on");
    await flush();
    expect(changes.map((c) => [c.entityId, c.newState?.state, c.resynced])).toEqual([
      ["light.kitchen", "on", false],
    ]);
  });

  it("applies a live change that is newer than the get_states snapshot after the resync", async () => {
    ha.setState("light.a", "off");
    ha.setState("light.b", "off");
    await client.start();

    await ha.stop();
    const backoff = await fake.next();
    await ha.start();
    ha.onCommand("get_states", () => {
      // Snapshot first (a changed during the outage), then a live change of b that is
      // newer than the snapshot and arrives while the sync is in progress.
      const snapshot = ha.getStates();
      ha.setState("light.b", "on", undefined, { at: Date.now() + 1_000 });
      return {
        result: snapshot.map((st) =>
          st.entity_id === "light.a"
            ? { ...st, state: "on", last_updated: new Date(Date.now() + 5_000).toISOString() }
            : st,
        ),
      };
    });
    const ready = new Promise<void>((r) => client.onReady(r));
    backoff.release();
    await ready;
    await flush();

    expect(client.states.get("light.a")?.state).toBe("on");
    expect(client.states.get("light.b")?.state).toBe("on");
    expect(changes.map((c) => [c.entityId, c.newState?.state, c.resynced])).toEqual([
      ["light.a", "on", true],
      ["light.b", "on", false],
    ]);
  });
});
