import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleScopeImpl } from "../../core/rule-scope.js";
import { invoke } from "../../core/run-context.js";
import { logCapture, TOKEN, type LogCapture } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { createWrites, type Writes } from "./writes.js";

describe("dry-run mode", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let writes: Writes;
  let capture: LogCapture;
  let scope: RuleScopeImpl;

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    ha.setState("light.porch", "on");
    await ha.start();
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
    );
    await client.start();
    writes = createWrites(client, capture.log, { dryRun: true });
    scope = new RuleScopeImpl("lights#porch", capture.log);
  });

  afterEach(async () => {
    await scope.dispose();
    await client.stop();
    await ha.stop();
  });

  async function inRule<T>(fn: () => Promise<T>): Promise<T | undefined> {
    let value: T | undefined;
    await invoke(scope, "body", async () => {
      value = await fn();
    }).done;
    return value;
  }

  const outgoing = () =>
    ha.received.filter((m) => ["call_service", "fire_event"].includes(String(m.type)));

  const dryRunLogs = () =>
    capture
      .entries()
      .filter((e) => String(e.message).startsWith("[dry-run]"))
      .map(({ level, message, source, ...rest }) => ({
        level,
        message,
        source,
        target: rest.target,
        data: rest.data,
      }));

  it("logs a service call with rule, target and data instead of sending it", async () => {
    await inRule(() => writes.forceOn("light.porch", { brightness_pct: 40 }));
    expect(outgoing()).toEqual([]);
    expect(ha.calls).toEqual([]);
    expect(dryRunLogs()).toEqual([
      {
        level: "info",
        message: "[dry-run] lights#porch light.turn_on",
        source: "lights#porch",
        target: { entity_id: "light.porch" },
        data: { brightness_pct: 40 },
      },
    ]);
  });

  it("resolves calls with an empty result, also when a response was requested", async () => {
    expect(await inRule(() => writes.call("light.turn_off"))).toBeUndefined();
    expect(
      await inRule(() =>
        writes.call("weather.get_forecasts", { type: "daily" }, undefined, {
          returnResponse: true,
        }),
      ),
    ).toEqual({});
  });

  it("logs events and state writes instead of sending them", async () => {
    await inRule(() => writes.fire("home_engine_alert", { level: "high" }));
    await inRule(() => writes.setState("sensor.comfort", "good", { friendly_name: "Comfort" }));
    expect(outgoing()).toEqual([]);
    expect(ha.restRequests).toEqual([]);
    expect(ha.getState("sensor.comfort")).toBeUndefined();
    const messages = capture.entries().filter((e) => String(e.message).startsWith("[dry-run]"));
    expect(messages).toEqual([
      expect.objectContaining({
        level: "info",
        message: "[dry-run] lights#porch fire home_engine_alert",
        data: { level: "high" },
      }),
      expect.objectContaining({
        level: "info",
        message: "[dry-run] lights#porch setState sensor.comfort",
        state: "good",
        attributes: { friendly_name: "Comfort" },
      }),
    ]);
  });

  it("keeps reads and the idempotent skip working", async () => {
    await inRule(() => writes.on("light.porch"));
    expect(client.states.get("light.porch")?.state).toBe("on");
    expect(dryRunLogs()).toEqual([]);
  });
});
