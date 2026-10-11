// An in-memory BackendAdapter for core tests: no network, fully driven by the test.

import type { BackendAdapter, BackendStatus, Disposable, SiteInfo } from "../adapter.js";
import type { ConfigProblem, Env } from "../config.js";
import type { RuleScope } from "../rule-scope.js";

export interface FakeConfig {
  name: string;
}

export interface FakeRuleApi {
  readonly ruleId: string;
  /** Records a subscription that is released with the rule. */
  subscribe(name: string): void;
}

export const DEFAULT_SITE: SiteInfo = {
  timeZone: "Europe/Berlin",
  latitude: 52.52,
  longitude: 13.405,
  elevation: 34,
  units: { temperature: "°C", length: "km" },
};

export class FakeAdapter implements BackendAdapter<FakeConfig, FakeRuleApi> {
  readonly id = "fake";
  /** Names of currently active subscriptions, as `<ruleId>:<name>`. */
  readonly subscriptions = new Set<string>();
  /** Every scope `createRuleApi` was called with. */
  readonly scopes: RuleScope[] = [];
  started = false;
  config: FakeConfig | undefined;

  private connected = false;
  private currentSite: SiteInfo | undefined;
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private readonly siteListeners = new Set<() => void>();

  constructor(private readonly initialSite: SiteInfo = DEFAULT_SITE) {}

  readonly readConfig = (env: Env): FakeConfig | ConfigProblem[] =>
    env.FAKE_FAIL
      ? [{ message: `FAKE_FAIL: ${env.FAKE_FAIL}` }]
      : { name: env.FAKE_NAME ?? "fake" };

  async start(config: FakeConfig, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.config = config;
    this.started = true;
    this.currentSite = this.initialSite;
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.setConnected(false);
    this.statusListeners.clear();
    this.siteListeners.clear();
  }

  status(): BackendStatus {
    return { connected: this.connected, details: { adapter: this.id } };
  }

  onStatusChange(callback: (connected: boolean) => void): Disposable {
    this.statusListeners.add(callback);
    return { dispose: () => this.statusListeners.delete(callback) };
  }

  site(): SiteInfo | undefined {
    return this.currentSite;
  }

  onSiteChange(callback: () => void): Disposable {
    this.siteListeners.add(callback);
    return { dispose: () => this.siteListeners.delete(callback) };
  }

  createRuleApi(scope: RuleScope): FakeRuleApi {
    this.scopes.push(scope);
    return {
      ruleId: scope.ruleId,
      subscribe: (name) => {
        const key = `${scope.ruleId}:${name}`;
        this.subscriptions.add(key);
        scope.onDispose(() => {
          this.subscriptions.delete(key);
        });
      },
    };
  }

  // ------------------------------------------------------------ test controls

  /** Simulates a connection change and notifies status listeners when it changes. */
  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const cb of [...this.statusListeners]) cb(connected);
  }

  /** Simulates the backend reporting a new Site. */
  setSite(site: SiteInfo): void {
    this.currentSite = site;
    for (const cb of [...this.siteListeners]) cb();
  }
}
