import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockHomeAssistant } from "./mock-server.js";

/** Minimal raw client: collects every message and lets tests await specific ones. */
class RawClient {
  /** Messages not yet consumed by `next()`. */
  readonly messages: Array<Record<string, unknown>> = [];
  /** Every message ever received, in arrival order. */
  readonly log: Array<Record<string, unknown>> = [];
  private waiters: Array<{
    match: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }> = [];
  private nextId = 1;
  readonly closed: Promise<void>;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      this.log.push(msg);
      const waiter = this.waiters.find((w) => w.match(msg));
      if (!waiter) return void this.messages.push(msg);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(msg);
    });
    this.closed = new Promise((resolve) => ws.addEventListener("close", () => resolve()));
  }

  static async open(url: string): Promise<RawClient> {
    const ws = new WebSocket(url);
    const client = new RawClient(ws);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return client;
  }

  next(match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const seen = this.messages.find(match);
    if (seen) {
      this.messages.splice(this.messages.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  async command(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.send({ id, ...msg });
    return this.next((m) => m.id === id && (m.type === "result" || m.type === "pong"));
  }

  async auth(token = "test-token"): Promise<Record<string, unknown>> {
    await this.next((m) => m.type === "auth_required");
    this.send({ type: "auth", access_token: token });
    return this.next((m) => m.type === "auth_ok" || m.type === "auth_invalid");
  }
}

describe("MockHomeAssistant", () => {
  let ha: MockHomeAssistant;
  let client: RawClient | undefined;

  beforeEach(async () => {
    ha = new MockHomeAssistant();
    await ha.start();
  });

  afterEach(async () => {
    client?.ws.close();
    client = undefined;
    await ha.stop();
  });

  it("authenticates a raw WebSocket client and handles a service call", async () => {
    ha.setState("light.kitchen", "off", { friendly_name: "Kitchen" });
    client = await RawClient.open(ha.wsUrl);

    const auth = await client.auth();
    expect(auth).toEqual({ type: "auth_ok", ha_version: ha.version });

    const result = await client.command({
      type: "call_service",
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen" },
    });
    expect(result.success).toBe(true);
    expect(ha.calls).toHaveLength(1);
    expect(ha.calls[0]).toMatchObject({ domain: "light", service: "turn_on" });
    expect(ha.getState("light.kitchen")?.state).toBe("on");
    expect((result.result as { context: { user_id: string } }).context.user_id).toBe(ha.userId);
  });

  it("rejects an invalid token and closes the connection", async () => {
    client = await RawClient.open(ha.wsUrl);
    const auth = await client.auth("wrong");
    expect(auth.type).toBe("auth_invalid");
    await client.closed;
  });

  it("answers get_states, get_config, auth/current_user and ping", async () => {
    ha.setState("sensor.temp", "21.5", { unit_of_measurement: "°C" });
    client = await RawClient.open(ha.wsUrl);
    await client.auth();

    const states = await client.command({ type: "get_states" });
    expect(states.result).toEqual([
      expect.objectContaining({ entity_id: "sensor.temp", state: "21.5" }),
    ]);

    const config = await client.command({ type: "get_config" });
    expect(config.result).toMatchObject({ time_zone: "Europe/Berlin", version: ha.version });

    const user = await client.command({ type: "auth/current_user" });
    expect(user.result).toMatchObject({ id: ha.userId });

    expect(await client.command({ type: "ping" })).toMatchObject({ type: "pong" });
  });

  it("returns unknown_command for unsupported commands and unknown services", async () => {
    client = await RawClient.open(ha.wsUrl);
    await client.auth();
    const unknown = await client.command({ type: "nope" });
    expect(unknown).toMatchObject({ success: false, error: { code: "unknown_command" } });
    const service = await client.command({ type: "call_service", domain: "x", service: "y" });
    expect(service).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("delivers state_changed and pushed events to subscribers", async () => {
    client = await RawClient.open(ha.wsUrl);
    await client.auth();
    const stateSub = await client.command({
      type: "subscribe_events",
      event_type: "state_changed",
    });
    const zhaSub = await client.command({ type: "subscribe_events", event_type: "zha_event" });

    ha.setState("binary_sensor.door", "on");
    const change = await client.next((m) => m.id === stateSub.id && m.type === "event");
    expect(change.event).toMatchObject({
      event_type: "state_changed",
      data: { entity_id: "binary_sensor.door", old_state: null, new_state: { state: "on" } },
    });

    ha.pushEvent("zha_event", { command: "on" });
    const zha = await client.next((m) => m.id === zhaSub.id && m.type === "event");
    expect(zha.event).toMatchObject({ event_type: "zha_event", data: { command: "on" } });

    await client.command({
      type: "fire_event",
      event_type: "zha_event",
      event_data: { command: "off" },
    });
    const fired = await client.next((m) => m.id === zhaSub.id && m.type === "event");
    expect(fired.event).toMatchObject({ data: { command: "off" } });
  });

  it("sends state changes of a service call after its result, or before when configured", async () => {
    ha.setState("switch.pump", "off");
    client = await RawClient.open(ha.wsUrl);
    await client.auth();
    const c = client;
    const sub = await c.command({ type: "subscribe_events", event_type: "state_changed" });
    const call = async (service: string): Promise<string[]> => {
      const from = c.log.length;
      const result = await c.command({
        type: "call_service",
        domain: "switch",
        service,
        target: { entity_id: "switch.pump" },
      });
      await c.next((m) => m.id === sub.id && m.type === "event");
      return c.log
        .slice(from)
        .filter((m) => m.id === result.id || m.id === sub.id)
        .map((m) => String(m.type));
    };

    expect(await call("turn_on")).toEqual(["result", "event"]);
    ha.stateChangesBeforeResult = true;
    expect(await call("turn_off")).toEqual(["event", "result"]);
  });

  it("supports trigger subscriptions, validation and firing", async () => {
    ha.validateTrigger = (t) =>
      (t as { platform?: string }).platform === "bogus" ? "Invalid platform 'bogus'" : undefined;
    client = await RawClient.open(ha.wsUrl);
    await client.auth();

    const bad = await client.command({ type: "subscribe_trigger", trigger: { platform: "bogus" } });
    expect(bad).toMatchObject({ success: false, error: { message: "Invalid platform 'bogus'" } });

    const ok = await client.command({
      type: "subscribe_trigger",
      trigger: { platform: "numeric_state", entity_id: "sensor.humidity", above: 70 },
    });
    expect(ok.success).toBe(true);
    const [sub] = ha.triggerSubscriptions();
    if (!sub) throw new Error("expected a trigger subscription");
    expect(sub.trigger).toMatchObject({ platform: "numeric_state" });

    ha.fireTrigger(sub, { platform: "numeric_state", entity_id: "sensor.humidity" });
    const ev = await client.next((m) => m.id === ok.id && m.type === "event");
    expect(ev.event).toMatchObject({ variables: { trigger: { entity_id: "sensor.humidity" } } });

    await client.command({ type: "unsubscribe_events", subscription: ok.id });
    expect(ha.triggerSubscriptions()).toHaveLength(0);
  });

  it("serves history and statistics", async () => {
    const t0 = Date.parse("2026-10-01T10:00:00Z");
    ha.setState("sensor.power", "10", {}, { at: t0, silent: true });
    ha.setState("sensor.power", "20", {}, { at: t0 + 60_000, silent: true });
    ha.setState("sensor.power", "30", {}, { at: t0 + 120_000, silent: true });
    ha.setStatistics("sensor.energy", [
      { start: t0, end: t0 + 3_600_000, sum: 5, mean: 1, max: 2 },
      { start: t0 + 3_600_000, end: t0 + 7_200_000, sum: 7, mean: 2, max: 3 },
    ]);
    client = await RawClient.open(ha.wsUrl);
    await client.auth();

    const hist = await client.command({
      type: "history/history_during_period",
      start_time: new Date(t0 + 30_000).toISOString(),
      entity_ids: ["sensor.power"],
      no_attributes: true,
    });
    expect(
      (hist.result as Record<string, Array<{ s: string }>>)["sensor.power"]?.map((r) => r.s),
    ).toEqual(["10", "20", "30"]);

    const stats = await client.command({
      type: "recorder/statistics_during_period",
      start_time: new Date(t0 + 3_600_000).toISOString(),
      statistic_ids: ["sensor.energy"],
      period: "hour",
      types: ["sum"],
    });
    expect(stats.result).toEqual({
      "sensor.energy": [{ start: t0 + 3_600_000, end: t0 + 7_200_000, sum: 7 }],
    });
  });

  it("can drop connections, stop answering pings and restart on the same port", async () => {
    client = await RawClient.open(ha.wsUrl);
    await client.auth();
    ha.respondToPing = false;
    client.send({ id: 1, type: "ping" });

    ha.dropConnections();
    await client.closed;
    expect(client.messages.some((m) => m.type === "pong")).toBe(false);
    expect(ha.connectionCount).toBe(0);

    const port = ha.port;
    await ha.stop();
    await expect(RawClient.open(ha.wsUrl)).rejects.toBeDefined();
    await ha.start();
    expect(ha.port).toBe(port);
    const connected = ha.waitForConnection();
    client = await RawClient.open(ha.wsUrl);
    await client.auth();
    await expect(connected).resolves.toBeDefined();
  });
});
