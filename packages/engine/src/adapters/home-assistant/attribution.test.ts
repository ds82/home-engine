import type { RuleEvent, StateEvent } from "@home-engine/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleDefinition } from "../../core/registration.js";
import { startRule, type StartedRule } from "../../core/rule-runner.js";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import { CONTEXT_TTL_MS, WriteAttribution, trackedServiceCall } from "./attribution.js";
import { HaClient } from "./client.js";
import { homeAssistantTriggerSources } from "./event-triggers.js";
import { MockHomeAssistant, newContext } from "./testing/mock-server.js";
import { onChange } from "./trigger-constructors.js";

describe("change cause", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  const rules: StartedRule[] = [];

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN], userId: "engine-user" });
    await ha.start();
    client = new HaClient(
      {
        baseUrl: ha.url,
        wsUrl: ha.wsUrl,
        restUrl: `${ha.url}/api`,
        token: TOKEN,
        supervisor: false,
      },
      logCapture([]).log,
    );
    ha.setState("light.hall", "off");
    await client.start();
  });

  afterEach(async () => {
    for (const r of rules.splice(0)) {
      await r.stop();
    }
    await client.stop();
    await ha.stop();
  });

  /** A rule triggered by changes of `entity`, recording its state events. */
  async function watch(entity: string, id = "hall#log-manual"): Promise<StateEvent[]> {
    const events: StateEvent[] = [];
    const definition: RuleDefinition = {
      kind: "triggered",
      id,
      name: id.split("#")[1] ?? id,
      file: "hall.ts",
      triggers: onChange(entity),
      body: (e: RuleEvent) => void (e.type === "state" && events.push(e)),
      options: {},
    };
    rules.push(
      await startRule(definition, {
        sources: homeAssistantTriggerSources(client),
        log: logCapture([]).log,
      }),
    );
    return events;
  }

  function turnOn(ruleId: string, entity = "light.hall") {
    const session = client.connection.current;
    if (!session) {
      throw new Error("not connected");
    }
    return trackedServiceCall(client.attribution, session, ruleId, {
      domain: "light",
      service: "turn_on",
      target: { entity_id: entity },
    });
  }

  async function flush(): Promise<void> {
    await client.connection.current?.command({ type: "ping" });
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it("names the rule whose write caused a change", async () => {
    const events = await watch("light.hall");
    await turnOn("hall#auto-light");
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      causedBy: "engine",
      causedByEngine: true,
      causedByRule: "hall#auto-light",
    });
  });

  it("attributes a rule's own write even when Home Assistant sends the state change first", async () => {
    ha.stateChangesBeforeResult = true;
    const events = await watch("light.hall", "hall#auto-light");
    await turnOn("hall#auto-light");
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ causedByEngine: true, causedByRule: "hall#auto-light" });
  });

  it("reports manual changes as external without a causing rule", async () => {
    const events = await watch("light.hall");
    ha.setState("light.hall", "on", undefined, { context: newContext(null) });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ causedBy: "external", causedByEngine: false });
    expect(events[0]?.causedByRule).toBeUndefined();
  });

  it("reports a Home Assistant automation reacting to an engine write as external", async () => {
    const events = await watch("light.y");
    const { context } = await turnOn("hall#auto-light", "switch.x");
    ha.setState("light.y", "on", undefined, { context: newContext(null, context.id) });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ causedBy: "external" });
    expect(events[0]?.causedByRule).toBeUndefined();
  });

  it("reports an engine-user change with an unknown context as engine without a rule", async () => {
    const events = await watch("light.hall");
    ha.setState("light.hall", "on", undefined, { context: newContext("engine-user") });
    await flush();
    expect(events[0]).toMatchObject({ causedBy: "engine", causedByEngine: true });
    expect(events[0]?.causedByRule).toBeUndefined();
  });

  it("holds an early engine event at most about a second when its write never answers", async () => {
    ha.stateChangesBeforeResult = true;
    ha.onService("light", "slow_on", (call, server) => {
      server.setState("light.hall", "on", undefined, { context: call.context });
      return new Promise(() => {});
    });
    const events = await watch("light.hall");
    const session = client.connection.current;
    if (!session) {
      throw new Error("not connected");
    }
    void trackedServiceCall(client.attribution, session, "hall#slow", {
      domain: "light",
      service: "slow_on",
      target: { entity_id: "light.hall" },
    }).catch(() => {});
    await flush();
    expect(events).toEqual([]);
    await new Promise((r) => setTimeout(r, 1_100));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ causedBy: "engine" });
    expect(events[0]?.causedByRule).toBeUndefined();
  });

  it("keeps the order of changes per entity while one is held", async () => {
    ha.stateChangesBeforeResult = true;
    let answer: () => void = () => {};
    ha.onService("light", "held_on", (call, server) => {
      server.setState("light.hall", "on", undefined, { context: call.context });
      return new Promise<undefined>((resolve) => (answer = () => resolve(undefined)));
    });
    const events = await watch("light.hall");
    const session = client.connection.current;
    if (!session) {
      throw new Error("not connected");
    }
    const write = trackedServiceCall(client.attribution, session, "hall#auto-light", {
      domain: "light",
      service: "held_on",
      target: { entity_id: "light.hall" },
    });
    await flush();
    // The engine's "on" is held while its write is in flight; a later manual change waits behind it.
    ha.setState("light.hall", "off", undefined, { context: newContext(null) });
    await flush();
    expect(events).toEqual([]);

    answer();
    await write;
    await flush();
    expect(events.map((e) => [e.to?.state, e.causedBy, e.causedByRule])).toEqual([
      ["on", "engine", "hall#auto-light"],
      ["off", "external", undefined],
    ]);
  });
});

describe("WriteAttribution", () => {
  it("forgets contexts after their TTL", async () => {
    let now = 0;
    const attribution = new WriteAttribution({ engineUserId: () => "u", now: () => now });
    await attribution.track("r#1", async () => ({
      context: { id: "c1", parent_id: null, user_id: "u" },
    }));
    expect(attribution.resolve({ id: "c1", parent_id: null, user_id: "u" })).toEqual({
      causedBy: "engine",
      causedByRule: "r#1",
    });
    now = CONTEXT_TTL_MS + 1;
    expect(attribution.resolve({ id: "c1", parent_id: null, user_id: "u" })).toEqual({
      causedBy: "engine",
    });
  });

  it("treats everything as external before the engine user is known", () => {
    const attribution = new WriteAttribution({ engineUserId: () => undefined });
    expect(attribution.resolve({ id: "x", parent_id: null, user_id: "u" })).toEqual({
      causedBy: "external",
    });
  });
});
