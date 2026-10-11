import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HaClient } from "./client.js";
import { FakeDelay } from "./testing/fake-delay.js";
import { TOKEN, logCapture } from "./testing/log-capture.js";
import { MockHomeAssistant } from "./testing/mock-server.js";

describe("HaClient status and Site", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let fake: FakeDelay;

  beforeEach(async () => {
    ha = new MockHomeAssistant({
      tokens: [TOKEN],
      userId: "user-123",
      version: "2026.10.2",
      config: { time_zone: "Europe/Berlin", latitude: 48.1, longitude: 11.6, elevation: 520 },
    });
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
    await client.stop();
    await ha.stop();
  });

  async function reconnect(): Promise<void> {
    const ready = new Promise<void>((r) => {
      const off = client.onReady(() => {
        off();
        r();
      });
    });
    ha.dropConnections();
    await fake.elapseNext();
    await ready;
  }

  it("loads the core config, Site and engine user on connect", async () => {
    await client.start();
    expect(client.userId).toBe("user-123");
    expect(client.config).toMatchObject({ version: "2026.10.2", time_zone: "Europe/Berlin" });
    expect(client.site()).toEqual({
      timeZone: "Europe/Berlin",
      latitude: 48.1,
      longitude: 11.6,
      elevation: 520,
      units: { length: "km", mass: "g", temperature: "°C", volume: "L" },
    });
    expect(client.status()).toEqual({
      connected: true,
      details: { haVersion: "2026.10.2", userId: "user-123", entities: 0, subscriptions: 2 },
    });
  });

  it("fetches get_config and auth/current_user again after every reconnect", async () => {
    await client.start();
    ha.config = { ...ha.config, time_zone: "UTC" };
    await reconnect();
    expect(ha.received.filter((m) => m.type === "get_config")).toHaveLength(2);
    expect(ha.received.filter((m) => m.type === "auth/current_user")).toHaveLength(2);
    expect(client.site()?.timeZone).toBe("UTC");
  });

  it("reports status changes and notifies a disconnect exactly once", async () => {
    const events: boolean[] = [];
    client.onStatusChange((c) => events.push(c));
    expect(client.status().connected).toBe(false);

    await client.start();
    expect(events).toEqual([true]);

    await ha.stop();
    const backoff = await fake.next();
    expect(client.status().connected).toBe(false);
    expect(events).toEqual([true, false]);

    // Further failed attempts do not notify again.
    backoff.release();
    const second = await fake.next();
    expect(events).toEqual([true, false]);

    await ha.start();
    const ready = new Promise<void>((r) => client.onReady(r));
    second.release();
    await ready;
    expect(events).toEqual([true, false, true]);
    expect(client.status().connected).toBe(true);
  });

  it("stops notifying a disposed listener", async () => {
    const events: boolean[] = [];
    const sub = client.onStatusChange((c) => events.push(c));
    await client.start();
    sub.dispose();
    await reconnect();
    expect(events).toEqual([true]);
  });

  it("notifies Site listeners when the location changes, also via core_config_updated", async () => {
    let siteChanges = 0;
    client.onSiteChange(() => siteChanges++);
    await client.start();
    expect(siteChanges).toBe(0);

    await reconnect();
    expect(siteChanges).toBe(0);

    ha.config = { ...ha.config, latitude: 50 };
    ha.pushEvent("core_config_updated", {});
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
    await client.connection.current?.command({ type: "ping" });
    expect(siteChanges).toBe(1);
    expect(client.site()?.latitude).toBe(50);
  });
});
