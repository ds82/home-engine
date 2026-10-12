import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuleScopeImpl } from "../../core/rule-scope.js";
import { invoke } from "../../core/run-context.js";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { readHomeAssistantConfig, type HomeAssistantConfig } from "./config.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import { createWrites, NotConnectedError, ServiceCallError, type Writes } from "./writes.js";

describe("setState and virtual entities", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let writes: Writes;
  let delay: FakeDelay;
  const scopes: RuleScopeImpl[] = [];

  const newScope = (ruleId: string): RuleScopeImpl => {
    const scope = new RuleScopeImpl(ruleId, logCapture([]).log);
    scopes.push(scope);
    return scope;
  };

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
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
    await client.start();
    writes = createWrites(client, logCapture([]).log);
  });

  afterEach(async () => {
    for (const scope of scopes.splice(0)) {
      await scope.dispose();
    }
    await client.stop();
    await ha.stop();
  });

  async function inRule<T>(
    scope: RuleScopeImpl,
    fn: () => T | Promise<T>,
  ): Promise<{ value?: T; error?: unknown }> {
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

  const flush = async (): Promise<void> => {
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
  };

  /** Simulates a Home Assistant restart: states set over REST are gone afterwards. */
  async function restartHomeAssistant(): Promise<void> {
    const ready = new Promise<void>((r) => {
      const off = client.onReady(() => {
        off();
        r();
      });
    });
    await ha.stop();
    for (const s of ha.getStates()) {
      ha.removeState(s.entity_id, { silent: true });
    }
    await ha.start();
    await delay.elapseNext();
    await ready;
  }

  it("creates a virtual sensor with its state and attributes over REST", async () => {
    const scope = newScope("comfort#rule");
    const { error } = await inRule(scope, () =>
      writes.setState("sensor.living_room_comfort", "good", { friendly_name: "Comfort" }),
    );
    expect(error).toBeUndefined();
    expect(ha.restRequests).toEqual([
      {
        method: "POST",
        path: "/api/states/sensor.living_room_comfort",
        body: { state: "good", attributes: { friendly_name: "Comfort" } },
      },
    ]);
    expect(ha.getState("sensor.living_room_comfort")).toMatchObject({
      state: "good",
      attributes: { friendly_name: "Comfort" },
    });
    await flush();
    expect(client.states.get("sensor.living_room_comfort")?.state).toBe("good");
  });

  it("attributes the change to the calling rule", async () => {
    const causes: unknown[] = [];
    client.dispatcher.watch(["sensor.comfort"], (c) => causes.push(c.cause));
    await inRule(newScope("comfort#rule"), () => writes.setState("sensor.comfort", 21.5));
    await flush();
    expect(ha.getState("sensor.comfort")?.state).toBe("21.5");
    expect(causes).toEqual([{ causedBy: "engine", causedByRule: "comfort#rule" }]);
  });

  it("rejects with Home Assistant's HTTP error", async () => {
    ha.setTokens(["other"]);
    const { error } = await inRule(newScope("r#1"), () => writes.setState("sensor.x", "1"));
    expect(error).toBeInstanceOf(ServiceCallError);
    expect(error).toMatchObject({ code: "http_401" });
  });

  it("rejects promptly while disconnected", async () => {
    await ha.stop();
    await delay.next();
    const { error } = await inRule(newScope("r#1"), () => writes.setState("sensor.x", "1"));
    expect(error).toBeInstanceOf(NotConnectedError);
  });

  it("validates entity, state and attributes at the call site", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const scope = newScope("r#1");
    expect((await inRule(scope, () => writes.setState("comfort", "x"))).error).toBeInstanceOf(
      TypeError,
    );
    expect(
      (await inRule(scope, () => writes.setState("sensor.x", {} as unknown as string))).error,
    ).toBeInstanceOf(TypeError);
    expect(
      ((await inRule(scope, () => writes.setState("sensor.x", "1", circular))).error as Error)
        .message,
    ).toMatch(/JSON-serialisable/);
  });

  it("republishes the last value of loaded rules' virtual entities after Home Assistant restarts", async () => {
    const kept = newScope("comfort#rule");
    const unloaded = newScope("old#rule");
    await inRule(kept, async () => {
      await writes.setState("sensor.comfort", "ok");
      await writes.setState("sensor.comfort", "good", { friendly_name: "Comfort" });
    });
    await inRule(unloaded, () => writes.setState("sensor.old", "x"));
    await unloaded.dispose();

    await restartHomeAssistant();
    await vi.waitFor(() =>
      expect(ha.getState("sensor.comfort")).toMatchObject({
        state: "good",
        attributes: { friendly_name: "Comfort" },
      }),
    );
    expect(ha.getState("sensor.old")).toBeUndefined();
  });

  it("hands an entity to the rule that wrote it last", async () => {
    const first = newScope("a#rule");
    const second = newScope("b#rule");
    await inRule(first, () => writes.setState("sensor.shared", "from a"));
    await inRule(second, () => writes.setState("sensor.shared", "from b"));
    await first.dispose();

    await restartHomeAssistant();
    await vi.waitFor(() => expect(ha.getState("sensor.shared")?.state).toBe("from b"));
  });

  it("publishes nothing for an engine that has not set the entity (no persistence across engine restarts)", async () => {
    await inRule(newScope("comfort#rule"), () => writes.setState("sensor.comfort", "good"));
    // A restarted engine is a fresh client and write layer.
    await client.stop();
    ha.removeState("sensor.comfort", { silent: true });
    const restUrl = `${ha.url}/api`;
    client = new HaClient(
      { baseUrl: ha.url, wsUrl: ha.wsUrl, restUrl, token: TOKEN, supervisor: false },
      logCapture([]).log,
    );
    createWrites(client, logCapture([]).log);
    const before = ha.restRequests.length;
    await client.start();
    await flush();
    expect(ha.restRequests.length).toBe(before);
    expect(ha.getState("sensor.comfort")).toBeUndefined();
  });

  it("posts to the Supervisor's core API in add-on mode", async () => {
    const config = readHomeAssistantConfig({ SUPERVISOR_TOKEN: "sup" }) as HomeAssistantConfig;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ entity_id: "sensor.x" })));
    const supervised = new HaClient(config, logCapture([]).log, { fetch });
    await supervised.rest("POST", "/states/sensor.x", { state: "1", attributes: {} });
    expect(fetch).toHaveBeenCalledWith(
      "http://supervisor/core/api/states/sensor.x",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer sup" }),
      }),
    );
  });
});
