import type { BusEvent, HaTriggerEvent, RuleEvent, Trigger } from "@home-engine/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleDefinition } from "../../core/registration.js";
import { RuleRegistry } from "../../core/rule-registry.js";
import { logCapture, TOKEN, type LogCapture } from "../../core/testing/log-capture.js";
import { onStartup } from "../../core/trigger-constructors.js";
import { HaClient } from "./client.js";
import { homeAssistantTriggerSources, matchesData } from "./event-triggers.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { onChange, onEvent, onTrigger } from "./trigger-constructors.js";

describe("matchesData", () => {
  it.each([
    [{ command: "on" }, { command: "on", device_ieee: "00:11" }, true],
    [{ command: "on" }, { command: "off" }, false],
    [{ args: { button: [1, 2] } }, { args: { button: 2, duration: 300 } }, true],
    [{ args: { button: [1, 2] } }, { args: { button: 3 } }, false],
    [{ args: { button: 1 } }, { args: "flat" }, false],
    [{ level: (v: unknown) => Number(v) > 5 }, { level: 7 }, true],
    [{ level: (v: unknown) => Number(v) > 5 }, {}, false],
    [{ missing: "x" }, {}, false],
  ])("%j matches %j: %s", (filter, data, expected) => {
    expect(matchesData(filter, data)).toBe(expected);
  });

  it("accepts a predicate on the whole data", () => {
    expect(matchesData((d) => d.a === 1, { a: 1 })).toBe(true);
  });
});

describe("event, native and startup triggers", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let delay: FakeDelay;
  let capture: LogCapture;
  let registry: RuleRegistry;

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    await ha.start();
    delay = new FakeDelay();
    capture = logCapture([]);
    client = new HaClient(
      {
        baseUrl: ha.url,
        wsUrl: ha.wsUrl,
        restUrl: `${ha.url}/api`,
        token: TOKEN,
        supervisor: false,
      },
      capture.log,
      { delay: delay.delay, random: () => 1 },
    );
    registry = new RuleRegistry({ sources: homeAssistantTriggerSources(client), log: capture.log });
    await client.start();
  });

  afterEach(async () => {
    await registry.unloadAll();
    await client.stop();
    await ha.stop();
  });

  /** Loads a rule (in its own file) whose body records every event. */
  async function load(triggers: Trigger | Trigger[], file = "test.ts"): Promise<RuleEvent[]> {
    const events: RuleEvent[] = [];
    const definition: RuleDefinition = {
      kind: "triggered",
      id: `${file.replace(".ts", "")}#rule`,
      name: "rule",
      file,
      triggers,
      body: (e) => void events.push(e),
      options: {},
    };
    await registry.loadFile(file, [definition]);
    return events;
  }

  async function flush(): Promise<void> {
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

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
    await flush();
  }

  it("runs the body for a matching bus event with its data, origin and time", async () => {
    const events = await load(onEvent("zha_event", { device_ieee: "00:11", command: "on" }));
    await flush(); // the subscription must exist before events are pushed
    ha.pushEvent(
      "zha_event",
      { device_ieee: "00:11", command: "on", args: [] },
      { origin: "LOCAL" },
    );
    ha.pushEvent("zha_event", { device_ieee: "00:11", command: "off" });
    await flush();
    expect(events).toHaveLength(1);
    const event = events[0] as BusEvent;
    expect(event).toMatchObject({
      type: "event",
      eventType: "zha_event",
      data: { command: "on" },
      origin: "LOCAL",
      context: { id: expect.any(String) },
    });
    expect(event.timeFired).toBeInstanceOf(Date);
  });

  it("matches nested partial filters with array leaves", async () => {
    const events = await load(onEvent("zha_event", { args: { button: [1, 2] } }));
    await flush();
    ha.pushEvent("zha_event", { args: { button: 2, duration: 300 } });
    ha.pushEvent("zha_event", { args: { button: 4 } });
    await flush();
    expect(events.map((e) => (e as BusEvent).data)).toEqual([
      { args: { button: 2, duration: 300 } },
    ]);
  });

  it("shares one subscription per event type and releases it on unload", async () => {
    await load(onEvent("zha_event"), "a.ts");
    await load(onEvent("zha_event", { command: "on" }), "b.ts");
    await flush();
    expect(ha.eventSubscriptions().filter((s) => s.eventType === "zha_event")).toHaveLength(1);
    await registry.unloadAll();
    await flush();
    expect(ha.eventSubscriptions().filter((s) => s.eventType === "zha_event")).toHaveLength(0);
  });

  it("runs the body for a native trigger with Home Assistant's trigger variables", async () => {
    const events = await load(
      onTrigger({ platform: "numeric_state", entity_id: "sensor.humidity", above: 70 }),
    );
    await flush();
    const [sub] = ha.triggerSubscriptions();
    if (!sub) {
      throw new Error("expected a trigger subscription");
    }
    expect(sub.trigger).toEqual({
      platform: "numeric_state",
      entity_id: "sensor.humidity",
      above: 70,
    });
    ha.fireTrigger(sub, {
      platform: "numeric_state",
      entity_id: "sensor.humidity",
      to_state: { state: "72" },
    });
    await flush();
    expect(events).toHaveLength(1);
    expect((events[0] as HaTriggerEvent).variables).toMatchObject({
      trigger: { platform: "numeric_state", entity_id: "sensor.humidity" },
    });
  });

  it("keeps the rule running when Home Assistant rejects a trigger config", async () => {
    ha.validateTrigger = (t) =>
      (t as { platform?: string }).platform === "bogus" ? "Invalid platform 'bogus'" : undefined;
    ha.setState("light.hall", "off");
    await flush();
    const events = await load([onTrigger({ platform: "bogus" }), onChange("light.hall")]);
    await flush();

    const info = registry.rule("test#rule");
    expect(info).toMatchObject({
      status: "running",
      lastError: expect.stringContaining("Invalid platform 'bogus'"),
      triggerErrors: [
        {
          kind: "ha-trigger",
          position: 1,
          trigger: "ha-trigger bogus",
          message: expect.stringContaining("Invalid platform 'bogus'"),
        },
      ],
    });
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "test#rule",
        message: expect.stringMatching(/^Trigger 1 \(ha-trigger bogus\) rejected: /),
      }),
    );

    ha.setState("light.hall", "on");
    await flush();
    expect(events.map((e) => e.type)).toEqual(["state"]);
  });

  it("names the position and platform of the rejected one of two native triggers", async () => {
    ha.validateTrigger = (t) =>
      (t as { platform?: string }).platform === "numeric_state" ? "Expected a number" : undefined;
    await load([
      onTrigger({ platform: "zone", entity_id: "person.dennis", zone: "zone.home" }),
      onTrigger({ platform: "numeric_state", entity_id: "sensor.humidity", above: "high" }),
    ]);
    await flush();
    expect(registry.rule("test#rule")).toMatchObject({
      status: "running",
      triggerErrors: [
        {
          kind: "ha-trigger",
          position: 2,
          trigger: "ha-trigger numeric_state",
          message: expect.stringContaining("Expected a number"),
        },
      ],
    });
  });

  it("reports a rejection again when the trigger is re-subscribed after a reconnect", async () => {
    let reject = false;
    ha.validateTrigger = () => (reject ? "Integration removed" : undefined);
    await load(onTrigger({ platform: "zone", entity_id: "person.dennis", zone: "zone.home" }));
    await flush();
    expect(registry.rule("test#rule")?.triggerErrors).toEqual([]);
    reject = true;
    await reconnect();
    expect(registry.rule("test#rule")).toMatchObject({
      status: "running",
      triggerErrors: [
        { kind: "ha-trigger", message: expect.stringContaining("Integration removed") },
      ],
    });
  });

  it("fires onStartup when the rule starts and on reload, but not on reconnect", async () => {
    let events = await load([onStartup(), onChange("sun.sun")]);
    await flush();
    expect(events.map((e) => e.type)).toEqual(["startup"]);

    await reconnect();
    expect(events.map((e) => e.type)).toEqual(["startup"]);

    await registry.unloadFile("test.ts");
    events = await load([onStartup(), onChange("sun.sun")]);
    await flush();
    expect(events.map((e) => e.type)).toEqual(["startup"]);
  });
});
