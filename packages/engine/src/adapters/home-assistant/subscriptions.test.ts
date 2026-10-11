import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HomeAssistantConfig } from "./config.js";
import { HaConnection } from "./connection.js";
import { HaCommandError } from "./session.js";
import { SubscriptionRegistry, type HaEvent } from "./subscriptions.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { TOKEN, logCapture } from "../../core/testing/log-capture.js";
import { MockHomeAssistant } from "./testing/mock-server.js";

describe("SubscriptionRegistry", () => {
  let ha: MockHomeAssistant;
  let conn: HaConnection;
  let registry: SubscriptionRegistry;
  let fake: FakeDelay;
  /** Resolves after the next attach (initial or replay) completed. */
  let attached: Promise<void>;
  let notifyAttached: () => void = () => {};

  beforeEach(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    await ha.start();
    const config: HomeAssistantConfig = {
      baseUrl: ha.url,
      wsUrl: ha.wsUrl,
      restUrl: `${ha.url}/api`,
      token: TOKEN,
      supervisor: false,
    };
    const { log } = logCapture();
    fake = new FakeDelay();
    conn = new HaConnection({ config, log, delay: fake.delay, random: () => 1 });
    registry = new SubscriptionRegistry(log);
    attached = new Promise((r) => (notifyAttached = r));
    conn.onSession((session) => {
      void registry.attach(session).then(() => {
        notifyAttached();
        attached = new Promise((r) => (notifyAttached = r));
      });
    });
  });

  afterEach(async () => {
    await conn.stop();
    await ha.stop();
  });

  /**
   * Round trip to Home Assistant so that pending messages have been processed. The extra
   * macrotask matters: Node's WebSocket may dispatch several frames in one task, so promise
   * chains started by earlier frames can still be running when the pong resolves.
   */
  async function flush(): Promise<void> {
    await conn.current?.command({ type: "ping" });
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function reconnect(): Promise<void> {
    const next = attached;
    ha.dropConnections();
    await fake.elapseNext();
    await next;
  }

  it("shares one state_changed subscription between all handlers", async () => {
    await conn.start();
    const a: string[] = [];
    const b: string[] = [];
    const subA = registry.onStateChanged((e) => a.push(String(e.data.entity_id)));
    registry.onStateChanged((e) => b.push(String(e.data.entity_id)));
    await flush();
    expect(ha.eventSubscriptions()).toEqual([
      { id: expect.any(Number), eventType: "state_changed" },
    ]);

    ha.setState("light.kitchen", "on");
    await flush();
    expect(a).toEqual(["light.kitchen"]);
    expect(b).toEqual(["light.kitchen"]);

    subA.dispose();
    ha.setState("light.kitchen", "off");
    await flush();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    expect(ha.eventSubscriptions()).toHaveLength(1);
  });

  it("reference-counts event types and unsubscribes when the last handler goes", async () => {
    await conn.start();
    const s1 = registry.onEvent("zha_event", () => {});
    const s2 = registry.onEvent("zha_event", () => {});
    registry.onEvent("call_service", () => {});
    await flush();
    expect(
      ha
        .eventSubscriptions()
        .map((s) => s.eventType)
        .sort(),
    ).toEqual(["call_service", "zha_event"]);

    s1.dispose();
    await flush();
    expect(ha.eventSubscriptions()).toHaveLength(2);
    s2.dispose();
    await flush();
    await flush();
    expect(ha.eventSubscriptions().map((s) => s.eventType)).toEqual(["call_service"]);
  });

  it("restores event subscriptions after a reconnect (event subscription restored)", async () => {
    const received: Array<Record<string, unknown>> = [];
    registry.onEvent("zha_event", (e: HaEvent) => received.push(e.data));
    await conn.start();
    await attached;

    ha.pushEvent("zha_event", { command: "before" });
    await flush();

    await reconnect();
    ha.pushEvent("zha_event", { command: "after" });
    await flush();

    expect(received).toEqual([{ command: "before" }, { command: "after" }]);
    expect(ha.eventSubscriptions()).toEqual([{ id: expect.any(Number), eventType: "zha_event" }]);
  });

  it("subscribes registrations made while disconnected once connected", async () => {
    await conn.start();
    await ha.stop();
    const backoff = await fake.next();
    const received: unknown[] = [];
    registry.onEvent("zha_event", (e) => received.push(e.data));
    expect(conn.current).toBeUndefined();

    await ha.start();
    const next = attached;
    backoff.release();
    await next;
    ha.pushEvent("zha_event", { n: 1 });
    await flush();
    expect(received).toEqual([{ n: 1 }]);
  });

  it("does not replay disposed subscriptions", async () => {
    await conn.start();
    const sub = registry.onEvent("zha_event", () => {});
    await flush();
    sub.dispose();
    await reconnect();
    expect(ha.eventSubscriptions()).toEqual([]);
  });

  it("gives each native trigger its own subscription and replays it", async () => {
    await conn.start();
    const fired: Array<Record<string, unknown>> = [];
    const trigger = { platform: "numeric_state", entity_id: "sensor.humidity", above: 70 };
    registry.onTrigger(
      trigger,
      (v) => fired.push(v),
      () => {},
    );
    registry.onTrigger(
      trigger,
      () => {},
      () => {},
    );
    await flush();
    expect(ha.triggerSubscriptions()).toHaveLength(2);

    await reconnect();
    const [first, second] = ha.triggerSubscriptions();
    if (!first || !second) throw new Error("expected two trigger subscriptions after replay");
    ha.fireTrigger(first, { platform: "numeric_state", entity_id: "sensor.humidity" });
    await flush();
    expect(fired).toEqual([
      { trigger: { platform: "numeric_state", entity_id: "sensor.humidity" } },
    ]);
  });

  it("reports rejected trigger configs, also on replay", async () => {
    let reject = true;
    ha.validateTrigger = () => (reject ? "Invalid trigger" : undefined);
    await conn.start();
    const errors: Error[] = [];
    registry.onTrigger(
      { platform: "bogus" },
      () => {},
      (e) => errors.push(e),
    );
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HaCommandError);

    await reconnect();
    expect(errors).toHaveLength(2);

    reject = false;
    await reconnect();
    expect(errors).toHaveLength(2);
    expect(ha.triggerSubscriptions()).toHaveLength(1);
  });

  it("keeps dispatching when one handler throws", async () => {
    await conn.start();
    const ok: unknown[] = [];
    registry.onEvent("zha_event", () => {
      throw new Error("boom");
    });
    registry.onEvent("zha_event", (e) => ok.push(e.data));
    await flush();
    ha.pushEvent("zha_event", { x: 1 });
    await flush();
    expect(ok).toEqual([{ x: 1 }]);
  });
});
