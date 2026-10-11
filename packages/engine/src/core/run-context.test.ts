import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { logCapture } from "./testing/log-capture.js";
import { RuleScopeImpl } from "./rule-scope.js";
import { currentRun, invoke, requireRun } from "./run-context.js";

function scope(id = "lights#porch") {
  const capture = logCapture([]);
  return { scope: new RuleScopeImpl(id, capture.log), ...capture };
}

describe("RuleScope cleanup", () => {
  it("runs user teardowns (newest first), then aborts, then disposers (newest first)", async () => {
    const { scope: s } = scope();
    const order: string[] = [];
    s.onDispose(() => void order.push(`dispose 1 (aborted: ${s.signal.aborted})`));
    s.onDispose(() => void order.push("dispose 2"));
    s.addTeardown(() => void order.push(`teardown 1 (aborted: ${s.signal.aborted})`));
    s.addTeardown(async () => {
      await sleep(5);
      order.push("teardown 2");
    });

    await s.dispose();
    await s.dispose();

    expect(order).toEqual([
      "teardown 2",
      "teardown 1 (aborted: false)",
      "dispose 2",
      "dispose 1 (aborted: true)",
    ]);
    expect(s.signal.aborted).toBe(true);
    expect((s.signal.reason as Error).name).toBe("AbortError");
  });

  it("contains a throwing teardown: logs it and still runs the rest", async () => {
    const { scope: s, entries } = scope();
    const ran: string[] = [];
    s.onDispose(() => void ran.push("cleanup"));
    s.addTeardown(() => void ran.push("first teardown"));
    s.addTeardown(() => {
      throw new Error("teardown boom");
    });

    await expect(s.dispose()).resolves.toBeUndefined();
    expect(ran).toEqual(["first teardown", "cleanup"]);
    expect(entries()).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "lights#porch",
        message: "Teardown failed",
        err: expect.objectContaining({ message: "teardown boom" }),
      }),
    );
  });

  it("releases resources registered after unload immediately", async () => {
    const { scope: s } = scope();
    await s.dispose();
    let released = false;
    s.onDispose(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(true);
  });
});

describe("invoke", () => {
  it("isolates a throwing body: logs it with rule ID and stack, and the next run works", async () => {
    const { scope: s, entries } = scope();
    await invoke(s, "body", () => {
      throw new TypeError("cannot read x of undefined");
    }).done;
    await invoke(s, "body", async () => {
      await sleep(1);
      throw new Error("async failure");
    }).done;
    let ranAgain = false;
    await invoke(s, "body", () => {
      ranAgain = true;
    }).done;

    expect(ranAgain).toBe(true);
    const errors = entries().filter((e) => e.level === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      source: "lights#porch",
      err: {
        type: "TypeError",
        message: "cannot read x of undefined",
        stack: expect.stringContaining("TypeError"),
      },
    });
    expect(s.lastError?.message).toBe("async failure");
    expect(s.lastRunAt).toBeInstanceOf(Date);
  });

  it("swallows AbortErrors from the engine's own aborts", async () => {
    const { scope: s, entries } = scope();
    const run = invoke(s, "body", (signal) => sleep(60_000, undefined, { signal }));
    run.abort();
    await run.done;

    const unloaded = invoke(s, "body", (signal) => sleep(60_000, undefined, { signal }));
    await s.dispose();
    await unloaded.done;

    expect(entries().filter((e) => e.level === "error")).toEqual([]);
    expect(s.lastError).toBeUndefined();
  });

  it("still reports AbortErrors that the engine did not cause", async () => {
    const { scope: s, entries } = scope();
    await invoke(s, "body", () => {
      const err = new Error("request timed out");
      err.name = "AbortError";
      throw err;
    }).done;
    expect(entries().filter((e) => e.level === "error")).toHaveLength(1);
  });

  it("gives each run its own signal that also aborts on unload", async () => {
    const { scope: s } = scope();
    const a = invoke(s, "body", () => sleep(1));
    const b = invoke(s, "body", () => sleep(1));
    a.abort();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    await s.dispose();
    expect(b.signal.aborted).toBe(true);
    await Promise.all([a.done, b.done]);
  });

  it("attributes calls to the right rule across await chains, timers and interleaving", async () => {
    const porch = scope("lights#porch").scope;
    const heating = scope("climate#heating").scope;
    const seen: string[] = [];
    const record = (label: string): void => {
      seen.push(`${label}:${currentRun()?.scope.ruleId ?? "none"}`);
    };
    const body = (label: string) => async () => {
      record(`${label}-start`);
      await sleep(5);
      record(`${label}-after-await`);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          record(`${label}-in-timer`);
          resolve();
        }, 1),
      );
      await Promise.resolve().then(() => record(`${label}-in-then`));
    };

    await Promise.all([
      invoke(porch, "body", body("p")).done,
      invoke(heating, "body", body("h")).done,
    ]);
    record("outside");

    for (const label of ["start", "after-await", "in-timer", "in-then"]) {
      expect(seen).toContain(`p-${label}:lights#porch`);
      expect(seen).toContain(`h-${label}:climate#heating`);
    }
    expect(seen).toContain("outside:none");
  });

  it("makes the run signal available to SDK functions, and rejects calls without a rule", async () => {
    const { scope: s } = scope();
    let signal: AbortSignal | undefined;
    const run = invoke(s, "listener", () => {
      signal = requireRun("sleep").signal;
    });
    await run.done;
    expect(signal).toBe(run.signal);
    expect(() => requireRun("sleep")).toThrow(/sleep\(\) must be called from rule code/);
  });
});
