import { describe, expect, expectTypeOf, it } from "vitest";
import type { BackendAdapter } from "../adapter.js";
import { loadConfig } from "../config.js";
import type { RuleScope } from "../rule-scope.js";
import { DEFAULT_SITE, FakeAdapter } from "./fake-adapter.js";

function scope(ruleId: string): RuleScope & { dispose(): Promise<void> } {
  const controller = new AbortController();
  const disposers: Array<() => void | Promise<void>> = [];
  return {
    ruleId,
    signal: controller.signal,
    onDispose: (fn) => {
      disposers.push(fn);
      return () => void disposers.splice(disposers.indexOf(fn), 1);
    },
    async dispose() {
      controller.abort();
      for (const fn of disposers.reverse()) await fn();
    },
  };
}

describe("FakeAdapter", () => {
  it("implements BackendAdapter", () => {
    expectTypeOf<FakeAdapter>().toExtend<BackendAdapter>();
  });

  it("plugs into core config loading", () => {
    const adapter = new FakeAdapter();
    const opts = { checkRulesDir: () => undefined };
    expect(loadConfig({ FAKE_NAME: "x" }, adapter.readConfig, opts).backend).toEqual({ name: "x" });
    expect(() => loadConfig({ FAKE_FAIL: "bad" }, adapter.readConfig, opts)).toThrow(
      /FAKE_FAIL: bad/,
    );
  });

  it("reports status and site, and notifies listeners until disposed", async () => {
    const adapter = new FakeAdapter();
    const changes: boolean[] = [];
    const sub = adapter.onStatusChange((c) => changes.push(c));
    let siteChanges = 0;
    adapter.onSiteChange(() => siteChanges++);

    expect(adapter.site()).toBeUndefined();
    await adapter.start({ name: "x" }, new AbortController().signal);
    expect(adapter.status().connected).toBe(true);
    expect(adapter.site()).toEqual(DEFAULT_SITE);

    adapter.setConnected(false);
    sub.dispose();
    adapter.setConnected(true);
    expect(changes).toEqual([true, false]);

    adapter.setSite({ ...DEFAULT_SITE, timeZone: "UTC" });
    expect(siteChanges).toBe(1);
    expect(adapter.site()?.timeZone).toBe("UTC");
  });

  it("releases a rule's subscriptions through its scope", async () => {
    const adapter = new FakeAdapter();
    const s = scope("lights#porch");
    const api = adapter.createRuleApi(s);
    api.subscribe("light.porch");
    expect(adapter.subscriptions).toEqual(new Set(["lights#porch:light.porch"]));
    await s.dispose();
    expect(adapter.subscriptions.size).toBe(0);
  });
});
