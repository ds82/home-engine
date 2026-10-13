import type { RuleEvent, StateEvent, Trigger } from "@home-engine/sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FiredHolds } from "../../core/fired-holds.js";
import { Storage, storageSdk } from "../../core/storage.js";
import type { RuleDefinition } from "../../core/registration.js";
import { listen, startRule, type StartedRule } from "../../core/rule-runner.js";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { stateTriggerSource } from "./state-triggers.js";
import { FakeClock } from "../../core/testing/fake-clock.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { onChange } from "./trigger-constructors.js";

const MIN = 60_000;

describe("holds (for), restoration and immediate", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let clock: FakeClock;
  let delay: FakeDelay;
  let dir: string;
  let fired: FiredHolds;
  const running: StartedRule[] = [];

  beforeEach(async () => {
    clock = new FakeClock();
    ha = new MockHomeAssistant({ tokens: [TOKEN], now: () => clock.now() });
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
    dir = mkdtempSync(join(tmpdir(), "he-holds-"));
    fired = new FiredHolds(join(dir, "fired-holds.json"));
  });

  afterEach(async () => {
    for (const r of running.splice(0)) {
      await r.stop();
    }
    await client.stop();
    await ha.stop();
    await fired.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  function sources() {
    return {
      state: stateTriggerSource({
        dispatcher: client.dispatcher,
        cache: client.states,
        clock,
        firedHolds: fired,
        connection: { isReady: () => client.isReady, onReady: (l) => client.onReady(l) },
      }),
    };
  }

  /** Starts a triggered rule; the returned list collects the state events of its body. */
  async function start(triggers: Trigger | Trigger[], id = "test#rule"): Promise<StateEvent[]> {
    if (!client.isReady) {
      await client.start();
    }
    const events: StateEvent[] = [];
    const definition: RuleDefinition = {
      kind: "triggered",
      id,
      name: "rule",
      file: "test.ts",
      triggers,
      body: (e: RuleEvent) => void (e.type === "state" && events.push(e)),
      options: {},
    };
    running.push(await startRule(definition, { sources: sources(), log: logCapture([]).log }));
    return events;
  }

  async function unloadAll(): Promise<void> {
    for (const r of running.splice(0)) {
      await r.stop();
    }
  }

  async function flush(): Promise<void> {
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  /** Advances the fake clock and lets fired bodies run. */
  async function advance(ms: number): Promise<void> {
    clock.advance(ms);
    await new Promise((r) => setImmediate(r));
  }

  const set = (id: string, state: string, offsetMs = 0, attrs?: Record<string, unknown>) =>
    ha.setState(id, state, attrs, { at: clock.now() + offsetMs });

  describe("hold-for-duration", () => {
    it("fires once after the state held for the duration", async () => {
      set("switch.lawn_watering", "off");
      const events = await start(onChange("switch.lawn_watering", { to: "on", for: "20m" }));
      set("switch.lawn_watering", "on");
      await flush();
      await advance(19 * MIN);
      expect(events).toEqual([]);
      await advance(1 * MIN);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        entityId: "switch.lawn_watering",
        to: { state: "on" },
        restored: false,
      });
      await advance(60 * MIN);
      expect(events).toHaveLength(1);
    });

    it("fires both a rule and a listener that share one trigger object", async () => {
      set("switch.lawn_watering", "off");
      const watering = onChange("switch.lawn_watering", { to: "on", for: "20m" });
      const events = await start(watering);
      const heard: StateEvent[] = [];
      running.push(
        await startRule(
          {
            kind: "setup",
            id: "test#setup",
            name: "setup",
            file: "test.ts",
            options: {},
            fn: () => void listen(watering, (e) => void heard.push(e as StateEvent)),
          },
          { sources: sources(), log: logCapture([]).log },
        ),
      );
      set("switch.lawn_watering", "on");
      await flush();
      await advance(20 * MIN);
      expect(events).toHaveLength(1);
      expect(heard).toHaveLength(1);
    });

    it("keeps the fired-holds record out of the rule's store", async () => {
      const storage = new Storage(join(dir, "storage"), logCapture([]).log);
      await storage.load();
      const { store } = storageSdk(storage);
      set("switch.lawn_watering", "off");
      let keys: string[] = [];
      if (!client.isReady) {
        await client.start();
      }
      running.push(
        await startRule(
          {
            kind: "triggered",
            id: "test#rule",
            name: "rule",
            file: "test.ts",
            triggers: onChange("switch.lawn_watering", { to: "on", for: "20m" }),
            body: () => {
              store.set("runs", (store.get<number>("runs") ?? 0) + 1);
              keys = store.keys();
            },
            options: {},
          },
          { sources: sources(), log: logCapture([]).log },
        ),
      );
      set("switch.lawn_watering", "on");
      await flush();
      await advance(20 * MIN);
      expect(fired.all()).toHaveLength(1);
      expect(keys).toEqual(["runs"]);
      expect(storage.namespace("test#rule").keys()).toEqual(["runs"]);
    });

    it("does not fire when the condition is interrupted", async () => {
      set("switch.lawn_watering", "off");
      const events = await start(onChange("switch.lawn_watering", { to: "on", for: "20m" }));
      set("switch.lawn_watering", "on");
      await flush();
      await advance(3 * MIN);
      set("switch.lawn_watering", "off");
      await flush();
      await advance(60 * MIN);
      expect(events).toEqual([]);
    });

    it("restarts the hold on a change from one matching value to another", async () => {
      set("sensor.temperature", "24");
      const events = await start(
        onChange("sensor.temperature", { to: (s: string) => Number(s) > 25, for: "10m" }),
      );
      set("sensor.temperature", "26");
      await flush();
      await advance(4 * MIN);
      set("sensor.temperature", "27");
      await flush();
      await advance(9 * MIN);
      expect(events).toEqual([]);
      await advance(1 * MIN);
      expect(events.map((e) => e.to?.state)).toEqual(["27"]);
    });

    it("debounces a flapping sensor, tracking each entity independently", async () => {
      set("binary_sensor.bath_window_tilt", "off");
      set("binary_sensor.bath_window_open", "off");
      const events = await start(
        onChange(["binary_sensor.bath_window_tilt", "binary_sensor.bath_window_open"], {
          for: "30s",
        }),
      );
      for (const state of ["on", "off", "on"]) {
        set("binary_sensor.bath_window_tilt", state);
        await flush();
        await advance(3_000);
      }
      await advance(5_000);
      set("binary_sensor.bath_window_open", "on");
      await flush();
      await advance(60_000);
      expect(events.map((e) => e.entityId)).toEqual([
        "binary_sensor.bath_window_tilt",
        "binary_sensor.bath_window_open",
      ]);
    });

    it("shares one hold between entities with holdAs: group", async () => {
      set("binary_sensor.bath_window_tilt", "off");
      set("binary_sensor.bath_window_open", "off");
      const events = await start(
        onChange(["binary_sensor.bath_window_tilt", "binary_sensor.bath_window_open"], {
          for: "30s",
          holdAs: "group",
        }),
      );
      set("binary_sensor.bath_window_tilt", "on");
      await flush();
      await advance(5_000);
      set("binary_sensor.bath_window_open", "on");
      await flush();
      await advance(60_000);
      expect(events.map((e) => e.entityId)).toEqual(["binary_sensor.bath_window_open"]);
    });

    it("keeps a hold across unavailability with ignoreUnavailable", async () => {
      set("light.hall", "off");
      const events = await start(
        onChange("light.hall", { to: "on", for: "10m", ignoreUnavailable: true }),
      );
      set("light.hall", "on");
      await flush();
      await advance(4 * MIN);
      set("light.hall", "unavailable");
      set("light.hall", "on");
      await flush();
      await advance(6 * MIN);
      expect(events).toHaveLength(1);
    });
  });

  describe("restoration on rule start", () => {
    const trigger = onChange("light.hall", { to: "on", for: "10m" });

    it("restores a hold on reload and fires after the remaining time, marked restored", async () => {
      set("light.hall", "on", -6 * MIN);
      await start(trigger);
      await unloadAll();
      const events = await start(trigger);
      await advance(4 * MIN - 1_000);
      expect(events).toEqual([]);
      await advance(1_000);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ restored: true, entityId: "light.hall", from: undefined });
    });

    it("fires right after start when the hold elapsed during downtime", async () => {
      set("light.hall", "on", -25 * MIN);
      const events = await start(trigger);
      expect(events).toEqual([]);
      await advance(0);
      expect(events).toHaveLength(1);
      expect(events[0]?.restored).toBe(true);
    });

    it("does not fire a hold again that already fired before a reload", async () => {
      const door = onChange("binary_sensor.garage_door", { to: "on", for: "5m" });
      set("binary_sensor.garage_door", "off");
      let events = await start(door);
      set("binary_sensor.garage_door", "on");
      await flush();
      await advance(5 * MIN);
      expect(events).toHaveLength(1);

      await advance(3 * 24 * 60 * MIN);
      await unloadAll();
      events = await start(door);
      await advance(0);
      expect(events).toEqual([]);
    });

    it("does not fire a restored hold twice either", async () => {
      set("light.hall", "on", -25 * MIN);
      let events = await start(trigger);
      await advance(0);
      expect(events).toHaveLength(1);
      await unloadAll();
      events = await start(trigger);
      await advance(0);
      expect(events).toEqual([]);
    });

    it("treats an edited trigger as new and fires it", async () => {
      set("binary_sensor.garage_door", "on", -3 * 24 * 60 * MIN);
      let events = await start(onChange("binary_sensor.garage_door", { to: "on", for: "5m" }));
      await advance(0);
      expect(events).toHaveLength(1);
      await unloadAll();
      events = await start(onChange("binary_sensor.garage_door", { to: "on", for: "10m" }));
      await advance(0);
      expect(events).toHaveLength(1);
      expect(events[0]?.restored).toBe(true);
    });

    it("persists the fired-holds record in its own file across engine restarts", async () => {
      set("light.hall", "on", -25 * MIN);
      let events = await start(trigger);
      await advance(0);
      expect(events).toHaveLength(1);
      await unloadAll();
      await fired.flush();

      const file = join(dir, "fired-holds.json");
      expect(JSON.parse(readFileSync(file, "utf8")).holds).toEqual([
        expect.objectContaining({ ruleId: "test#rule", entityId: "light.hall" }),
      ]);
      fired = new FiredHolds(file);
      await fired.load();
      events = await start(trigger);
      await advance(0);
      expect(events).toEqual([]);
    });

    it("restores a group hold from the entity that changed last", async () => {
      set("binary_sensor.bath_window_tilt", "on", -40_000);
      set("binary_sensor.bath_window_open", "on", -10_000);
      const events = await start(
        onChange(["binary_sensor.bath_window_tilt", "binary_sensor.bath_window_open"], {
          for: "30s",
          holdAs: "group",
        }),
      );
      await advance(19_000);
      expect(events).toEqual([]);
      await advance(1_000);
      expect(events.map((e) => [e.entityId, e.restored])).toEqual([
        ["binary_sensor.bath_window_open", true],
      ]);
    });

    it("counts a restored hold from the end of a brief unavailability", async () => {
      ha.setState("light.hall", "on", undefined, { at: clock.now() - 8 * MIN });
      ha.setState("light.hall", "unavailable", undefined, { at: clock.now() - 3 * MIN });
      ha.setState("light.hall", "on", undefined, { at: clock.now() - 3 * MIN + 5_000 });
      const events = await start(
        onChange("light.hall", { to: "on", for: "10m", ignoreUnavailable: true }),
      );
      await advance(7 * MIN);
      expect(events).toEqual([]);
      await advance(5_000);
      expect(events).toHaveLength(1);
    });

    it("does not restore holds with a from filter", async () => {
      set("lock.door", "unlocked", -6 * MIN);
      const events = await start(
        onChange("lock.door", { from: "locked", to: "unlocked", for: "5m" }),
      );
      await advance(60 * MIN);
      expect(events).toEqual([]);
    });

    it("restores listeners registered during setup under their explicit id", async () => {
      if (!client.isReady) {
        await client.start();
      }
      set("light.a", "on", -6 * MIN);
      await flush();
      const events: StateEvent[] = [];
      const setupDef = (extraFirst: boolean): RuleDefinition => ({
        kind: "setup",
        id: "test#setup",
        name: "setup",
        file: "test.ts",
        options: {},
        fn: () => {
          if (extraFirst) {
            listen(onChange("light.other"), () => {});
          }
          listen(
            onChange("light.a", { to: "on", for: "10m" }),
            (e) => void events.push(e as StateEvent),
            {
              id: "a-on",
            },
          );
        },
      });
      running.push(
        await startRule(setupDef(false), { sources: sources(), log: logCapture([]).log }),
      );
      await advance(4 * MIN);
      expect(events).toHaveLength(1);
      await unloadAll();

      // A conditional listener before it shifts positions; the id keeps its identity.
      running.push(
        await startRule(setupDef(true), { sources: sources(), log: logCapture([]).log }),
      );
      await advance(0);
      expect(events).toHaveLength(1);
      expect(fired.all()).toEqual([
        expect.objectContaining({ identity: expect.stringMatching(/^id:a-on\./) }),
      ]);
    });

    it("does not restore holds for listeners registered after setup", async () => {
      if (!client.isReady) {
        await client.start();
      }
      set("light.a", "on", -6 * MIN);
      set("light.trigger", "off");
      await flush();
      expect(client.states.get("light.a")?.state).toBe("on");
      const events: StateEvent[] = [];
      running.push(
        await startRule(
          {
            kind: "setup",
            id: "test#late",
            name: "late",
            file: "test.ts",
            options: {},
            fn: () => {
              listen(onChange("light.trigger", { to: "on" }), () => {
                listen(
                  onChange("light.a", { to: "on", for: "10m" }),
                  (e) => void events.push(e as StateEvent),
                );
              });
            },
          },
          { sources: sources(), log: logCapture([]).log },
        ),
      );
      set("light.trigger", "on");
      await flush();
      await advance(60 * MIN);
      expect(events).toEqual([]);
    });
  });

  describe("immediate", () => {
    it("fires once when the rule starts and the state already matches", async () => {
      set("light.porch", "on");
      set("light.other", "off");
      const events = await start(
        onChange(["light.porch", "light.other"], { to: "on", immediate: true }),
      );
      await new Promise((r) => setImmediate(r));
      expect(events.map((e) => [e.entityId, e.restored, e.from])).toEqual([
        ["light.porch", false, undefined],
      ]);
    });

    it("evaluates late listeners at the time listen() is called", async () => {
      if (!client.isReady) {
        await client.start();
      }
      set("light.porch", "on");
      set("light.trigger", "off");
      await flush();
      const events: StateEvent[] = [];
      running.push(
        await startRule(
          {
            kind: "setup",
            id: "test#late-immediate",
            name: "late",
            file: "test.ts",
            options: {},
            fn: () => {
              listen(onChange("light.trigger", { to: "on" }), () => {
                listen(
                  onChange("light.porch", { to: "on", immediate: true }),
                  (e) => void events.push(e as StateEvent),
                );
              });
            },
          },
          { sources: sources(), log: logCapture([]).log },
        ),
      );
      expect(events).toEqual([]);
      set("light.trigger", "on");
      await flush();
      expect(events.map((e) => e.entityId)).toEqual(["light.porch"]);
    });
  });

  describe("disconnects and resync", () => {
    async function reconnect(whileDown: () => void): Promise<void> {
      await ha.stop();
      const backoff = await delay.next();
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
      await new Promise((r) => setImmediate(r));
    }

    it("defers a hold that runs out while disconnected and fires it after resync if unchanged", async () => {
      set("switch.lawn_watering", "off");
      const events = await start(onChange("switch.lawn_watering", { to: "on", for: "20m" }));
      set("switch.lawn_watering", "on");
      await flush();
      await ha.stop();
      const backoff = await delay.next();
      await advance(25 * MIN);
      expect(events).toEqual([]);
      await ha.start();
      const ready = new Promise<void>((r) => client.onReady(r));
      backoff.release();
      await ready;
      await new Promise((r) => setImmediate(r));
      expect(events).toHaveLength(1);
    });

    it("drops a hold that ran out while disconnected when the state changed", async () => {
      set("switch.lawn_watering", "off");
      const events = await start(onChange("switch.lawn_watering", { to: "on", for: "20m" }));
      set("switch.lawn_watering", "on");
      await flush();
      await ha.stop();
      const backoff = await delay.next();
      await advance(25 * MIN);
      ha.setState("switch.lawn_watering", "off", undefined, { at: clock.now(), silent: true });
      await ha.start();
      const ready = new Promise<void>((r) => client.onReady(r));
      backoff.release();
      await ready;
      await new Promise((r) => setImmediate(r));
      await advance(60 * MIN);
      expect(events).toEqual([]);
    });

    it("counts a hold started during a disconnect from the state's last_changed", async () => {
      set("switch.pump", "off");
      const events = await start(onChange("switch.pump", { to: "on", for: "10m" }));
      await reconnect(() => {
        ha.setState("switch.pump", "on", undefined, { at: clock.now() - 4 * MIN, silent: true });
      });
      await advance(6 * MIN - 1_000);
      expect(events).toEqual([]);
      await advance(1_000);
      expect(events).toHaveLength(1);
      expect(events[0]?.resynced).toBe(true);
    });
  });
});
