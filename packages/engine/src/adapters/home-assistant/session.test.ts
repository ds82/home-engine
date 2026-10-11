import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../core/logger.js";
import { HaCommandError, HaDisconnectedError, HaSession, HaTimeoutError } from "./session.js";
import { openAuthenticatedSocket } from "./socket.js";
import { MockHomeAssistant } from "./testing/mock-server.js";

const log = createLogger({ level: "fatal", format: "json" });

describe("HaSession", () => {
  let ha: MockHomeAssistant;
  let session: HaSession;

  beforeEach(async () => {
    ha = new MockHomeAssistant();
    await ha.start();
    const { ws } = await openAuthenticatedSocket({ wsUrl: ha.wsUrl, token: "test-token", log });
    session = new HaSession(ws, { log, timeoutMs: 2_000 });
  });

  afterEach(async () => {
    session.close();
    await ha.stop();
  });

  it("resolves each request with its own result, even when answers arrive out of order", async () => {
    const release: Array<() => void> = [];
    ha.onCommand(
      "slow",
      (msg) => new Promise((resolve) => release.push(() => resolve({ result: `slow-${msg.id}` }))),
    );
    ha.onCommand("fast", (msg) => ({ result: `fast-${msg.id}` }));

    const slow = session.command({ type: "slow" });
    const fast = session.command({ type: "fast" });
    await expect(fast).resolves.toMatch(/^fast-2$/);
    release[0]?.();
    await expect(slow).resolves.toBe("slow-1");
  });

  it("returns results of real commands", async () => {
    ha.setState("light.kitchen", "on");
    const states = await session.command<Array<{ entity_id: string }>>({ type: "get_states" });
    expect(states.map((s) => s.entity_id)).toEqual(["light.kitchen"]);
    await expect(session.command({ type: "ping" })).resolves.toBeUndefined();
  });

  it("rejects with HaCommandError on an error result", async () => {
    const err = await session
      .command({ type: "call_service", domain: "nope", service: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HaCommandError);
    expect(err).toMatchObject({ code: "not_found", command: "call_service" });
  });

  it("rejects with HaTimeoutError when no answer arrives in time, and ignores the late answer", async () => {
    let answer: (() => void) | undefined;
    ha.onCommand(
      "never",
      () => new Promise((resolve) => (answer = () => resolve({ result: "late" }))),
    );
    const err = await session
      .command({ type: "never" }, { timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HaTimeoutError);
    expect(err).toMatchObject({ command: "never", timeoutMs: 50 });

    answer?.();
    await expect(session.command({ type: "ping" })).resolves.toBeUndefined();
  });

  it("rejects all pending requests when the connection drops", async () => {
    ha.onCommand("hang", () => new Promise(() => {}));
    const a = session.command({ type: "hang" });
    const b = session.command({ type: "hang" });
    let closed = false;
    session.onClose(() => (closed = true));

    ha.dropConnections();

    await expect(a).rejects.toBeInstanceOf(HaDisconnectedError);
    await expect(b).rejects.toBeInstanceOf(HaDisconnectedError);
    expect(closed).toBe(true);
    expect(session.isOpen).toBe(false);
    await expect(session.command({ type: "ping" })).rejects.toBeInstanceOf(HaDisconnectedError);
  });

  it("routes subscription events by ID and stops after unsubscribe", async () => {
    const zha: unknown[] = [];
    const states: unknown[] = [];
    const zhaId = await session.subscribe(
      { type: "subscribe_events", event_type: "zha_event" },
      (e) => zha.push(e),
    );
    await session.subscribe({ type: "subscribe_events", event_type: "state_changed" }, (e) =>
      states.push(e),
    );

    ha.pushEvent("zha_event", { command: "on" });
    ha.setState("switch.a", "on");
    await session.command({ type: "ping" });
    expect(zha).toEqual([
      expect.objectContaining({ event_type: "zha_event", data: { command: "on" } }),
    ]);
    expect(states).toHaveLength(1);

    await session.unsubscribe(zhaId);
    ha.pushEvent("zha_event", { command: "off" });
    await session.command({ type: "ping" });
    expect(zha).toHaveLength(1);
  });

  it("does not keep a handler for a rejected subscription", async () => {
    ha.validateTrigger = () => "bad trigger";
    await expect(
      session.subscribe({ type: "subscribe_trigger", trigger: {} }, () => {}),
    ).rejects.toBeInstanceOf(HaCommandError);
  });

  it("handles coalesced message arrays", async () => {
    ha.onCommand("pair", (msg, conn) => {
      conn.send([{ id: msg.id, type: "result", success: true, result: "first" }]);
      return { handled: true };
    });
    await expect(session.command({ type: "pair" })).resolves.toBe("first");
  });
});
