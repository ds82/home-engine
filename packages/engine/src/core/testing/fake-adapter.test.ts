import { describe, expect, expectTypeOf, it } from "vitest";
import type { BackendAdapter } from "../adapter.js";
import { loadConfig } from "../config.js";
import { RuleScopeImpl } from "../rule-scope.js";
import { invoke } from "../run-context.js";
import { DEFAULT_SITE, FakeAdapter } from "./fake-adapter.js";
import { logCapture } from "./log-capture.js";

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
    const runtime = adapter.sdkRuntime() as { fakeSubscribe(name: string): void };
    const scope = new RuleScopeImpl("lights#porch", logCapture([]).log);
    await invoke(scope, "body", () => runtime.fakeSubscribe("light.porch")).done;
    expect(adapter.subscriptions).toEqual(new Set(["lights#porch:light.porch"]));
    await scope.dispose();
    expect(adapter.subscriptions.size).toBe(0);
  });
});
