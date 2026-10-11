import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleScopeImpl } from "../../core/rule-scope.js";
import { invoke } from "../../core/run-context.js";
import { logCapture, TOKEN } from "../../core/testing/log-capture.js";
import { HaClient } from "./client.js";
import { FakeClock } from "../../core/testing/fake-clock.js";
import { MockHomeAssistant } from "./testing/mock-server.js";
import type { HaState } from "./types.js";
import { createWaitFor, type WaitFor } from "./wait-for.js";

const MIN = 60_000;

describe("waitFor", () => {
  let ha: MockHomeAssistant;
  let client: HaClient;
  let clock: FakeClock;
  let waitFor: WaitFor;
  let scope: RuleScopeImpl;

  beforeEach(async () => {
    clock = new FakeClock();
    ha = new MockHomeAssistant({ tokens: [TOKEN], now: () => clock.now() });
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
    waitFor = createWaitFor(client, clock);
    scope = new RuleScopeImpl("test#rule", logCapture([]).log);
  });

  afterEach(async () => {
    await scope.dispose();
    await client.stop();
    await ha.stop();
  });

  async function flush(): Promise<void> {
    await client.connection.current?.command({ type: "ping" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  /** Calls waitFor inside a rule run and reports how the promise settled. */
  function waitInRun(...args: Parameters<WaitFor>) {
    const outcome: { value?: HaState | undefined; error?: unknown; settled: boolean } = {
      settled: false,
    };
    const run = invoke(scope, "body", async () => {
      try {
        outcome.value = await waitFor(...args);
      } catch (err) {
        outcome.error = err;
      } finally {
        outcome.settled = true;
      }
    });
    return { outcome, run };
  }

  it("resolves with the new state when the entity starts to match", async () => {
    ha.setState("light.garage", "on");
    await client.start();
    const { outcome } = waitInRun("light.garage", { to: "off" }, { timeout: "10m" });
    clock.advance(2 * MIN);
    ha.setState("light.garage", "off");
    await flush();
    expect(outcome.settled).toBe(true);
    expect(outcome.value).toMatchObject({ entity_id: "light.garage", state: "off" });
  });

  it("resolves with undefined on timeout", async () => {
    ha.setState("light.garage", "on");
    await client.start();
    const { outcome } = waitInRun("light.garage", { to: "off" }, { timeout: "10m" });
    clock.advance(10 * MIN - 1);
    await flush();
    expect(outcome.settled).toBe(false);
    clock.advance(1);
    await flush();
    expect(outcome.settled).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toBeUndefined();
  });

  it("resolves immediately when the entity already matches and no for is given", async () => {
    ha.setState("light.garage", "off");
    await client.start();
    const { outcome } = waitInRun("light.garage", { to: "off" });
    await flush();
    expect(outcome.value?.state).toBe("off");
  });

  it("waits for the state to hold, counting an existing match from last_changed", async () => {
    ha.setState("light.garage", "off", undefined, { at: clock.now() - 3 * MIN });
    await client.start();
    const { outcome } = waitInRun("light.garage", { to: "off" }, { for: "5m" });
    clock.advance(2 * MIN - 1);
    await flush();
    expect(outcome.settled).toBe(false);
    clock.advance(1);
    await flush();
    expect(outcome.value?.state).toBe("off");
  });

  it("restarts the hold when the entity stops matching", async () => {
    ha.setState("switch.pump", "off");
    await client.start();
    const { outcome } = waitInRun("switch.pump", { to: "on" }, { for: "5m" });
    ha.setState("switch.pump", "on");
    await flush();
    clock.advance(3 * MIN);
    ha.setState("switch.pump", "off");
    await flush();
    clock.advance(10 * MIN);
    await flush();
    expect(outcome.settled).toBe(false);
    ha.setState("switch.pump", "on");
    await flush();
    clock.advance(5 * MIN);
    await flush();
    expect(outcome.value?.state).toBe("on");
  });

  it("rejects when the rule is unloaded", async () => {
    ha.setState("light.garage", "on");
    await client.start();
    const { outcome } = waitInRun("light.garage", { to: "off" });
    await scope.dispose();
    await flush();
    expect(outcome.settled).toBe(true);
    expect((outcome.error as Error).name).toBe("AbortError");
  });

  it("rejects when the run is aborted (restart mode)", async () => {
    ha.setState("light.garage", "on");
    await client.start();
    const { outcome, run } = waitInRun("light.garage", { to: "off" });
    run.abort();
    await flush();
    expect((outcome.error as Error).name).toBe("AbortError");
  });

  it("validates its arguments at the call site", async () => {
    await client.start();
    const errors: string[] = [];
    await invoke(scope, "body", () => {
      for (const call of [
        () => waitFor("light.*", { to: "off" }),
        () => waitFor("light.garage", { too: "off" } as never),
        () => waitFor("light.garage", { to: "off" }, { timeout: "10 minutes" }),
      ]) {
        try {
          void call();
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
    }).done;
    expect(errors).toEqual([
      expect.stringMatching(/not an entity ID/),
      expect.stringMatching(/unknown filter option "too"/),
      expect.stringMatching(/Invalid waitFor\(\) timeout/),
    ]);
  });

  it("must be called from rule code", async () => {
    await client.start();
    expect(() => waitFor("light.garage", { to: "off" })).toThrow(/must be called from rule code/);
  });
});
