import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleScopeImpl } from "../../core/rule-scope.js";
import { invoke } from "../../core/run-context.js";
import { logCapture, TOKEN, type LogCapture } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { createWrites, type Writes } from "./writes.js";

describe("on/off, forceOn/forceOff/toggle, up/down", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let writes: Writes;
  let capture: LogCapture;
  let scope: RuleScopeImpl;

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    ha.setState("light.kitchen", "on", { brightness: 100 });
    ha.setState("switch.fan", "off");
    ha.setState("switch.pump", "unavailable");
    ha.setState("climate.living", "off");
    ha.setState("cover.bath", "open", { current_position: 60 });
    ha.setState("cover.garage", "unknown");
    ha.onService("cover", "set_cover_position", (call, server) => {
      const id = String(call.target?.entity_id);
      server.setState(id, "open", { current_position: call.service_data.position });
      return undefined;
    });
    await ha.start();
    capture = logCapture([]);
    capture.log.level = "debug";
    client = new HaClient(
      {
        baseUrl: ha.url,
        wsUrl: ha.wsUrl,
        restUrl: `${ha.url}/api`,
        token: TOKEN,
        supervisor: false,
      },
      capture.log,
    );
    await client.start();
    writes = createWrites(client, capture.log);
    scope = new RuleScopeImpl("test#rule", capture.log);
  });

  afterEach(async () => {
    await scope.dispose();
    await client.stop();
    await ha.stop();
  });

  async function inRule(fn: () => Promise<void>): Promise<void> {
    let error: unknown;
    await invoke(scope, "body", async () => {
      try {
        await fn();
      } catch (err) {
        error = err;
      }
    }).done;
    if (error) {
      throw error;
    }
  }

  const sent = () =>
    ha.calls.map((c) => ({
      service: `${c.domain}.${c.service}`,
      target: c.target?.entity_id,
      data: c.service_data,
    }));

  it("sends nothing when on() finds the entity already on, and logs the skip", async () => {
    await inRule(() => writes.on("light.kitchen", { brightness_pct: 30 }));
    expect(ha.calls).toEqual([]);
    expect(ha.getState("light.kitchen")?.attributes).toEqual({ brightness: 100 });
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({ level: "debug", message: "on(light.kitchen) skipped: already on" }),
    );
  });

  it("calls the domain's turn_on when the entity is off", async () => {
    await inRule(() => writes.on("switch.fan"));
    expect(sent()).toEqual([{ service: "switch.turn_on", target: "switch.fan", data: {} }]);
  });

  it("switches an unavailable entity off, because it is not known to be off", async () => {
    await inRule(() => writes.off("switch.pump"));
    expect(sent()).toEqual([{ service: "switch.turn_off", target: "switch.pump", data: {} }]);
  });

  it("always sends forceOn, also when already on", async () => {
    await inRule(() => writes.forceOn("light.kitchen", { brightness_pct: 30 }));
    expect(sent()).toEqual([
      { service: "light.turn_on", target: "light.kitchen", data: { brightness_pct: 30 } },
    ]);
  });

  it("uses the domain's toggle when it has one and homeassistant.toggle otherwise", async () => {
    await inRule(() => writes.toggle("light.kitchen"));
    await inRule(() => writes.toggle("climate.living"));
    await inRule(() => writes.forceOff("climate.living"));
    expect(sent()).toEqual([
      { service: "light.toggle", target: "light.kitchen", data: {} },
      { service: "homeassistant.toggle", target: "climate.living", data: {} },
      { service: "homeassistant.turn_off", target: "climate.living", data: {} },
    ]);
  });

  it("moves a partially open cover down", async () => {
    await inRule(() => writes.down("cover.bath", 0));
    expect(sent()).toEqual([
      { service: "cover.set_cover_position", target: "cover.bath", data: { position: 0 } },
    ]);
  });

  it("does not move a cover that is already lower than requested", async () => {
    ha.setState("cover.bath", "open", { current_position: 20 });
    await client.connection.current?.command({ type: "ping" });
    await inRule(() => writes.down("cover.bath", 40));
    await inRule(() => writes.up("cover.bath", 10));
    expect(ha.calls).toEqual([]);
  });

  it("opens up to 100 by default and moves covers without a known position", async () => {
    await inRule(() => writes.up("cover.bath"));
    await inRule(() => writes.down("cover.garage"));
    expect(sent()).toEqual([
      { service: "cover.set_cover_position", target: "cover.bath", data: { position: 100 } },
      { service: "cover.set_cover_position", target: "cover.garage", data: { position: 0 } },
    ]);
  });

  it("validates entities and positions", async () => {
    await expect(inRule(() => writes.on("kitchen light"))).rejects.toThrow(/not an entity ID/);
    await expect(inRule(() => writes.down("cover.bath", 140))).rejects.toThrow(/between 0/);
  });
});
