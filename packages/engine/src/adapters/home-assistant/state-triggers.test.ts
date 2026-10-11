import type { RuleEvent, StateEvent, Trigger } from "@home-engine/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleDefinition } from "../../core/registration.js";
import { startRule, type StartedRule } from "../../core/rule-runner.js";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { stateTriggerSource } from "./state-triggers.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { onChange } from "./trigger-constructors.js";

describe("onChange arming", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let fake: FakeDelay;
  const rules: StartedRule[] = [];

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
  });

  afterEach(async () => {
    for (const r of rules.splice(0)) await r.stop();
    await client.stop();
    await ha.stop();
  });

  /** Starts a rule with the given triggers; returns the events its body received. */
  async function arm(triggers: Trigger | Trigger[]): Promise<StateEvent[]> {
    if (!client.isReady) await client.start();
    const events: StateEvent[] = [];
    const definition: RuleDefinition = {
      kind: "triggered",
      id: `test#rule${rules.length}`,
      name: "rule",
      file: "test.ts",
      triggers,
      body: (e: RuleEvent) => {
        if (e.type === "state") events.push(e);
      },
      options: {},
    };
    rules.push(
      await startRule(definition, {
        sources: { state: stateTriggerSource(client.dispatcher, client.states) },
        log: logCapture([]).log,
      }),
    );
    return events;
  }

  async function flush(): Promise<void> {
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  const states = (events: StateEvent[]) =>
    events.map((e) => [e.entityId, e.from?.state, e.to?.state]);

  it("runs the body once per state change of a single entity, with old and new state", async () => {
    ha.setState("binary_sensor.hall_motion", "off");
    const events = await arm(onChange("binary_sensor.hall_motion"));
    ha.setState("binary_sensor.hall_motion", "on");
    await flush();
    expect(states(events)).toEqual([["binary_sensor.hall_motion", "off", "on"]]);
    expect(events[0]).toMatchObject({
      type: "state",
      causedBy: "external",
      causedByEngine: false,
      resynced: false,
      restored: false,
    });
    expect(events[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("matches arrays of IDs and glob patterns", async () => {
    ha.setState("light.kitchen", "off");
    ha.setState("switch.fan", "off");
    const globbed = await arm(onChange("light.*"));
    const listed = await arm(onChange(["switch.fan", "sensor.x"]));
    ha.setState("light.kitchen", "on");
    ha.setState("switch.fan", "on");
    await flush();
    expect(states(globbed)).toEqual([["light.kitchen", "off", "on"]]);
    expect(states(listed)).toEqual([["switch.fan", "off", "on"]]);
  });

  it("fires for entities created after the rule started, including the creation itself", async () => {
    const events = await arm(onChange("sensor.new_*"));
    ha.setState("sensor.new_one", "1");
    ha.setState("sensor.new_one", "2");
    await flush();
    expect(states(events)).toEqual([
      ["sensor.new_one", undefined, "1"],
      ["sensor.new_one", "1", "2"],
    ]);
  });

  it("fires for a removed entity without filters, but never matches a to filter", async () => {
    ha.setState("sensor.old_one", "5");
    ha.setState("light.porch", "on");
    const removal = await arm(onChange("sensor.old_one"));
    const filtered = await arm(onChange("light.porch", { to: "on" }));
    ha.removeState("sensor.old_one");
    ha.removeState("light.porch");
    await flush();
    expect(states(removal)).toEqual([["sensor.old_one", "5", undefined]]);
    expect(filtered).toEqual([]);
  });

  it("applies to, from+to and predicate filters", async () => {
    ha.setState("binary_sensor.door", "on");
    ha.setState("person.dennis", "home");
    ha.setState("sensor.temperature", "24.5");
    const to = await arm(onChange("binary_sensor.door", { to: "on" }));
    const fromTo = await arm(onChange("person.dennis", { from: "home", to: "not_home" }));
    const predicate = await arm(
      onChange("sensor.temperature", { to: (s: string) => Number(s) > 25 }),
    );

    ha.setState("binary_sensor.door", "off");
    ha.setState("person.dennis", "not_home");
    ha.setState("sensor.temperature", "25.5");
    ha.setState("sensor.temperature", "20");
    await flush();

    expect(to).toEqual([]);
    expect(states(fromTo)).toEqual([["person.dennis", "home", "not_home"]]);
    expect(states(predicate)).toEqual([["sensor.temperature", "24.5", "25.5"]]);
  });

  it("matches arrays of values and non-string filter values", async () => {
    ha.setState("climate.living", "off");
    const events = await arm(onChange("climate.living", { to: ["heat", "cool"] }));
    for (const s of ["heat", "off", "cool", "dry"]) ha.setState("climate.living", s);
    await flush();
    expect(states(events).map((s) => s[2])).toEqual(["heat", "cool"]);
  });

  it("ignores unavailability with ignoreUnavailable, but reports real changes across it", async () => {
    ha.setState("light.x", "on");
    const ignoring = await arm(onChange("light.x", { to: "on", ignoreUnavailable: true }));
    const plain = await arm(onChange("light.x", { to: "on" }));

    ha.setState("light.x", "unavailable");
    ha.setState("light.x", "on");
    await flush();
    expect(ignoring).toEqual([]);
    expect(states(plain)).toEqual([["light.x", "unavailable", "on"]]);

    ha.setState("light.x", "off");
    ha.setState("light.x", "unknown");
    ha.setState("light.x", "on");
    await flush();
    expect(states(ignoring)).toEqual([["light.x", "off", "on"]]);
  });

  it("fires on state value changes only by default", async () => {
    ha.setState("light.kitchen", "on", { brightness: 100 });
    const events = await arm(onChange("light.kitchen"));
    ha.setState("light.kitchen", "on", { brightness: 200 });
    await flush();
    expect(events).toEqual([]);
  });

  it("watches a specific attribute and exposes its old and new value", async () => {
    ha.setState("light.kitchen", "on", { brightness: 100, color_temp: 300 });
    const events = await arm(onChange("light.kitchen", { attribute: "brightness" }));
    const filtered = await arm(
      onChange("light.kitchen", { attribute: "brightness", to: (b: unknown) => Number(b) > 150 }),
    );
    ha.setState("light.kitchen", "on", { brightness: 100, color_temp: 350 });
    ha.setState("light.kitchen", "on", { brightness: 200, color_temp: 350 });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ attribute: "brightness", oldValue: 100, newValue: 200 });
    expect(filtered).toHaveLength(1);
  });

  it('fires on any state or attribute change with attribute: "*"', async () => {
    ha.setState("light.kitchen", "on", { color_temp: 300 });
    const events = await arm(onChange("light.kitchen", { attribute: "*" }));
    ha.setState("light.kitchen", "on", { color_temp: 350 });
    ha.setState("light.kitchen", "off", { color_temp: 350 });
    await flush();
    expect(events).toHaveLength(2);
  });

  it("fires each matching trigger of one rule independently", async () => {
    ha.setState("light.kitchen", "off");
    const triggers = [onChange("light.*"), onChange("light.kitchen", { to: "on" })];
    const events = await arm(triggers);
    ha.setState("light.kitchen", "on");
    await flush();
    // Both fire; their order follows dispatch (exact IDs before globs), not declaration.
    expect(events.map((e) => e.trigger)).toHaveLength(2);
    expect(events.map((e) => e.trigger)).toEqual(expect.arrayContaining(triggers));
  });

  it("runs once per change when an entity matches several selectors of one trigger", async () => {
    ha.setState("light.kitchen", "off");
    const events = await arm(onChange(["light.kitchen", "light.*"]));
    ha.setState("light.kitchen", "on");
    await flush();
    expect(events).toHaveLength(1);
  });

  it("passes resynced changes through with resynced: true", async () => {
    ha.setState("binary_sensor.front_door", "off");
    const events = await arm(onChange("binary_sensor.front_door", { to: "on" }));
    await ha.stop();
    const backoff = await fake.next();
    ha.setState("binary_sensor.front_door", "on", undefined, { silent: true });
    await ha.start();
    const ready = new Promise<void>((r) => client.onReady(r));
    backoff.release();
    await ready;
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resynced: true,
      causedBy: "external",
      from: { state: "off" },
    });
  });

  it("stops firing after the rule is unloaded", async () => {
    ha.setState("light.kitchen", "off");
    const events = await arm(onChange("light.kitchen"));
    await rules.pop()?.stop();
    ha.setState("light.kitchen", "on");
    await flush();
    expect(events).toEqual([]);
  });
});
