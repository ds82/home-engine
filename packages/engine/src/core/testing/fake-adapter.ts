// An in-memory BackendAdapter for core tests: no network, fully driven by the test.

import type {
  AdapterContext,
  BackendAdapter,
  BackendStatus,
  Disposable,
  SiteInfo,
} from "../adapter.js";
import type { ConfigProblem, Env } from "../config.js";
import { requireRun } from "../run-context.js";
import type { SdkRuntime } from "../sdk-runtime.js";
import type { TriggerSources } from "../trigger-source.js";
import { FakeSources } from "./fake-sources.js";

export interface FakeConfig {
  name: string;
}

export const DEFAULT_SITE: SiteInfo = {
  timeZone: "Europe/Berlin",
  latitude: 52.52,
  longitude: 13.405,
  elevation: 34,
  units: { temperature: "°C", length: "km" },
};

export class FakeAdapter implements BackendAdapter<FakeConfig> {
  readonly id = "fake";
  /** Names of currently active subscriptions, as `<ruleId>:<name>`. */
  readonly subscriptions = new Set<string>();
  /** Drives `state` triggers: `fake.change("binary_sensor.motion")`. */
  readonly fake = new FakeSources();
  /** The context the core handed over, once it asked for trigger sources. */
  context: AdapterContext | undefined;
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

  triggerSources(context: AdapterContext): TriggerSources {
    this.context = context;
    const { state } = this.fake.sources;
    return state ? { state } : {};
  }

  /** `fakeSubscribe(name)` records a subscription of the calling rule, released with it. */
  sdkRuntime(): SdkRuntime {
    return {
      fakeSubscribe: (name: string) => {
        const { scope } = requireRun("fakeSubscribe");
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
