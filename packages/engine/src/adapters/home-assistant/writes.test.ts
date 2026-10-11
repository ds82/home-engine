import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleScopeImpl } from "../../core/rule-scope.js";
import { invoke } from "../../core/run-context.js";
import { logCapture, TOKEN, type LogCapture } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { createWrites, NotConnectedError, ServiceCallError, type Writes } from "./writes.js";

describe("call", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let writes: Writes;
  let capture: LogCapture;
  let scope: RuleScopeImpl;
  let delay: FakeDelay;

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    ha.setState("light.kitchen", "off");
    await ha.start();
    capture = logCapture([]);
    capture.log.level = "debug";
    delay = new FakeDelay();
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
    await client.start();
    writes = createWrites(client, capture.log);
    scope = new RuleScopeImpl("lights#kitchen", capture.log);
  });

  afterEach(async () => {
    await scope.dispose();
    await client.stop();
    await ha.stop();
  });

  /** Runs `fn` as rule code and returns its result or error. */
  async function inRule<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
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

  it("calls a service with data and target and resolves once Home Assistant acknowledged it", async () => {
    const result = await inRule(() =>
      writes.call("light.turn_on", { brightness_pct: 50 }, { entity_id: "light.kitchen" }),
    );
    expect(result).toEqual({ value: undefined });
    expect(ha.calls).toEqual([
      expect.objectContaining({
        domain: "light",
        service: "turn_on",
        service_data: { brightness_pct: 50 },
        target: { entity_id: "light.kitchen" },
      }),
    ]);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({
        level: "debug",
        source: "lights#kitchen",
        service: "light.turn_on",
      }),
    );
  });

  it("rejects with Home Assistant's error code and message for an unknown service", async () => {
    const { error } = await inRule(() => writes.call("light.does_not_exist"));
    expect(error).toBeInstanceOf(ServiceCallError);
    expect(error).toMatchObject({ service: "light.does_not_exist", code: "not_found" });
    expect((error as Error).message).toBe(
      "light.does_not_exist failed: Service light.does_not_exist not found. (not_found)",
    );
  });

  it("rejects promptly while disconnected instead of queueing the call", async () => {
    await ha.stop();
    await delay.next();
    const started = Date.now();
    const { error } = await inRule(() =>
      writes.call("light.turn_on", {}, { entity_id: "light.kitchen" }),
    );
    expect(error).toBeInstanceOf(NotConnectedError);
    expect((error as Error).message).toBe("light.turn_on: not connected to Home Assistant");
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("resolves with the service's response data when requested", async () => {
    const forecast = { "weather.home": { forecast: [{ condition: "sunny", temperature: 21 }] } };
    ha.onService("weather", "get_forecasts", () => ({ response: forecast }));
    const { value } = await inRule(() =>
      writes.call(
        "weather.get_forecasts",
        { type: "daily" },
        { entity_id: "weather.home" },
        { returnResponse: true },
      ),
    );
    expect(value).toEqual(forecast);
    expect(ha.calls.at(-1)).toMatchObject({
      return_response: true,
      service_data: { type: "daily" },
    });
  });

  it("attributes the resulting state change to the calling rule", async () => {
    const changes: unknown[] = [];
    client.dispatcher.watch(["light.kitchen"], (c) => changes.push(c.cause));
    await inRule(() => writes.call("light.turn_on", {}, { entity_id: "light.kitchen" }));
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
    expect(changes).toEqual([{ causedBy: "engine", causedByRule: "lights#kitchen" }]);
  });

  it("rejects malformed service names at the call site", async () => {
    let message = "";
    await invoke(scope, "body", () => {
      try {
        void writes.call("turn on the light");
      } catch (err) {
        message = (err as Error).message;
      }
    }).done;
    expect(message).toMatch(/is not a service name/);
  });
});
