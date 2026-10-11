import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { createStateHelpers, type StateHelpers } from "./state-helpers.js";
import { MockHomeAssistant } from "./testing/mock-server.js";

describe("state helpers", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let h: StateHelpers;

  beforeAll(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    ha.setState("sun.sun", "above_horizon", { elevation: 32.5, rising: false });
    ha.setState("light.kitchen", "on", { brightness: 200 });
    ha.setState("light.hall", "off");
    ha.setState("switch.fan", "unavailable");
    ha.setState("sensor.temperature", "unavailable");
    ha.setState("sensor.humidity", "61.5", { battery: 80, label: "n/a" });
    ha.setState("sensor.text", "hello");
    ha.setState("binary_sensor.front_door", "on", { device_class: "door" });
    ha.setState("binary_sensor.window", "off");
    ha.setState("cover.bath", "open", { current_position: 60 });
    ha.setState("lock.garage", "closed");
    ha.setState("group.rollershutters", "open", { entity_id: ["cover.bath", "cover.kitchen"] });
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
    await client.start();
    h = createStateHelpers(client.states);
  });

  afterAll(async () => {
    await client.stop();
    await ha.stop();
  });

  it("reads the full state object of a known entity", () => {
    expect(h.getEntity("sun.sun")).toMatchObject({
      entity_id: "sun.sun",
      state: "above_horizon",
      attributes: { elevation: 32.5 },
      last_changed: expect.any(String),
      last_updated: expect.any(String),
      context: expect.objectContaining({ id: expect.any(String) }),
    });
    expect(h.getState("light.kitchen")).toBe("on");
  });

  it("returns undefined for unknown entities instead of throwing", () => {
    expect(h.getState("sensor.unknown_entity")).toBeUndefined();
    expect(h.getEntity("sensor.unknown_entity")).toBeUndefined();
  });

  it("queries entities by pattern", () => {
    expect(h.getEntities("light.*").map((s) => s.entity_id)).toEqual([
      "light.hall",
      "light.kitchen",
    ]);
    expect(h.getEntities(["sun.sun", "binary_sensor.*"]).map((s) => s.entity_id)).toEqual([
      "binary_sensor.front_door",
      "binary_sensor.window",
      "sun.sun",
    ]);
  });

  it("lists group members, or nothing for unknown groups", () => {
    expect(h.members("group.rollershutters")).toEqual(["cover.bath", "cover.kitchen"]);
    expect(h.members("group.missing")).toEqual([]);
  });

  it("returns numbers for numeric states and attributes, undefined otherwise", () => {
    expect(h.getNumber("sensor.humidity")).toBe(61.5);
    expect(h.getNumber("sensor.humidity", "battery")).toBe(80);
    expect(h.getNumber("cover.bath", "current_position")).toBe(60);
    expect(h.getNumber("sensor.temperature")).toBeUndefined();
    expect(h.getNumber("sensor.text")).toBeUndefined();
    expect(h.getNumber("sensor.humidity", "label")).toBeUndefined();
    expect(h.getNumber("sensor.humidity", "missing")).toBeUndefined();
    expect(h.getNumber("sensor.unknown_entity")).toBeUndefined();
  });

  it("maps binary_sensor on/off to open/closed", () => {
    expect(h.isOpen("binary_sensor.front_door")).toBe(true);
    expect(h.isClosed("binary_sensor.front_door")).toBe(false);
    expect(h.isClosed("binary_sensor.window")).toBe(true);
  });

  it("recognises open and closed states and plain comparisons", () => {
    expect(h.isOpen("cover.bath")).toBe(true);
    expect(h.isClosed("lock.garage")).toBe(true);
    expect(h.isOpen("light.kitchen")).toBe(false);
    expect(h.is("sun.sun", "above_horizon")).toBe(true);
    expect(h.isOn("light.kitchen")).toBe(true);
    expect(h.isOff("light.hall")).toBe(true);
  });

  it("returns false from every predicate for unavailable or unknown entities", () => {
    expect(h.isOn("switch.fan")).toBe(false);
    expect(h.isOff("switch.fan")).toBe(false);
    expect(h.isOpen("switch.fan")).toBe(false);
    expect(h.isClosed("switch.fan")).toBe(false);
    expect(h.is("switch.fan", "unavailable")).toBe(false);
    expect(h.isOn("light.unknown")).toBe(false);
  });
});
