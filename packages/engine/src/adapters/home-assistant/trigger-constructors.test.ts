import { afterEach, describe, expect, it } from "vitest";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { onChange, onEvent, onTrigger } from "./trigger-constructors.js";

describe("onChange", () => {
  it("builds a frozen state descriptor from one ID, a list or globs", () => {
    expect(onChange("light.kitchen")).toEqual({ kind: "state", entities: ["light.kitchen"] });
    const multi = onChange(["binary_sensor.bath_tilt", "light.*"], {
      to: ["on", "open"],
      for: "30s",
      holdAs: "group",
      ignoreUnavailable: true,
    });
    expect(multi).toEqual({
      kind: "state",
      entities: ["binary_sensor.bath_tilt", "light.*"],
      to: ["on", "open"],
      for: "30s",
      holdAs: "group",
      ignoreUnavailable: true,
    });
    expect(Object.isFrozen(multi)).toBe(true);
    expect(Object.isFrozen(multi.entities)).toBe(true);
    expect(Object.isFrozen(multi.to)).toBe(true);
  });

  it("does not freeze or keep the caller's arrays", () => {
    const entities = ["light.a"];
    const to = ["on"];
    const trigger = onChange(entities, { to });
    entities.push("light.b");
    expect(Object.isFrozen(entities)).toBe(false);
    expect(Object.isFrozen(to)).toBe(false);
    expect(trigger.entities).toEqual(["light.a"]);
  });

  it("accepts predicates, attributes and immediate", () => {
    const pred = (s: string): boolean => Number(s) > 25;
    expect(onChange("sensor.temperature", { to: pred }).to).toBe(pred);
    expect(onChange("light.kitchen", { attribute: "*" }).attribute).toBe("*");
    expect(onChange("light.porch", { to: "on", immediate: true }).immediate).toBe(true);
  });

  it.each([
    ["no entity", () => onChange([]), /at least one entity/],
    ["a malformed ID", () => onChange("kitchen light"), /not an entity ID or pattern/],
    ["a non-string ID", () => onChange(42), /not an entity ID/],
    ["an unknown option", () => onChange("light.a", { too: "on" }), /unknown option "too"/],
    ["a bad duration", () => onChange("light.a", { for: "5 minutes" }), /Invalid onChange\(\) for/],
    ["an empty filter list", () => onChange("light.a", { to: [] }), /to must be/],
    ["an object filter", () => onChange("light.a", { from: {} }), /from must be/],
    ["holdAs without for", () => onChange("light.a", { holdAs: "group" }), /holdAs only applies/],
    ["an invalid holdAs", () => onChange("light.a", { for: 1, holdAs: "all" }), /holdAs must be/],
    [
      "immediate with for",
      () => onChange("light.a", { to: "on", for: "5m", immediate: true }),
      /immediate cannot be combined/,
    ],
    [
      "immediate with from",
      () => onChange("light.a", { from: "off", to: "on", immediate: true }),
      /immediate cannot be combined/,
    ],
    [
      "a non-boolean flag",
      () => onChange("light.a", { ignoreUnavailable: "yes" }),
      /ignoreUnavailable must be/,
    ],
    ["an empty attribute", () => onChange("light.a", { attribute: "" }), /attribute must be/],
    ["non-object options", () => onChange("light.a", "on"), /options must be an object/],
  ])("rejects %s", (_label, call, message) => {
    expect(call).toThrow(message);
  });
});

describe("onEvent", () => {
  it("builds a frozen event descriptor with an owned data filter", () => {
    const filter = { device_ieee: "00:11", args: { button: [1, 2] } };
    const trigger = onEvent("zha_event", filter);
    expect(trigger).toEqual({ kind: "event", eventType: "zha_event", dataFilter: filter });
    expect(Object.isFrozen(trigger.dataFilter)).toBe(true);
    expect(Object.isFrozen(filter)).toBe(false);
    expect(onEvent("call_service")).toEqual({ kind: "event", eventType: "call_service" });
  });

  it.each([
    ["an empty type", () => onEvent(""), /non-empty string/],
    ["a non-string type", () => onEvent(1), /non-empty string/],
    ["a non-object filter", () => onEvent("zha_event", "on"), /object or a function/],
  ])("rejects %s", (_label, call, message) => {
    expect(call).toThrow(message);
  });
});

describe("onTrigger", () => {
  it("builds a frozen native trigger descriptor", () => {
    const trigger = onTrigger({
      platform: "numeric_state",
      entity_id: "sensor.humidity",
      above: 70,
    });
    expect(trigger).toEqual({
      kind: "ha-trigger",
      config: { platform: "numeric_state", entity_id: "sensor.humidity", above: 70 },
    });
    expect(Object.isFrozen(trigger.config)).toBe(true);
    expect(onTrigger({ trigger: "time_pattern", minutes: "/5" }).config.trigger).toBe(
      "time_pattern",
    );
  });

  it.each([
    ["no platform", () => onTrigger({ entity_id: "x" }), /needs a "platform"/],
    ["a non-object", () => onTrigger("numeric_state"), /must be an object/],
  ])("rejects %s", (_label, call, message) => {
    expect(call).toThrow(message);
  });
});

describe("constructors have no effect on their own", () => {
  let ha: MockHomeAssistant | undefined;
  let client: HaClient | undefined;

  afterEach(async () => {
    await client?.stop();
    await ha?.stop();
  });

  it("subscribes nothing in Home Assistant", async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    await ha.start();
    client = new HaClient(
      {
        baseUrl: ha.url,
        wsUrl: ha.wsUrl,
        restUrl: `${ha.url}/api`,
        token: TOKEN,
        supervisor: false,
      },
      logCapture().log,
    );
    await client.start();
    const subscriptions = ha.eventSubscriptions().length;
    const sent = ha.received.length;

    onChange("light.kitchen", { to: "on" });
    onEvent("zha_event");
    onTrigger({ platform: "numeric_state", entity_id: "sensor.humidity", above: 70 });
    await client.connection.current?.command({ type: "ping" });

    expect(ha.eventSubscriptions()).toHaveLength(subscriptions);
    expect(ha.triggerSubscriptions()).toHaveLength(0);
    expect(ha.received.slice(sent).map((m) => m.type)).toEqual(["ping"]);
  });
});
