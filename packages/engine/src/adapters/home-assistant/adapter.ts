// The Home Assistant backend adapter (design D13): connects the client and hands the core its
// trigger sources (state, event, ha-trigger) and SDK functions (reads, writes, history, ...).

import type {
  AdapterContext,
  BackendAdapter,
  BackendStatus,
  Disposable,
  SiteInfo,
} from "../../core/adapter.js";
import type { Logger } from "../../core/logger.js";
import type { SdkRuntime } from "../../core/sdk-runtime.js";
import type { TriggerSources } from "../../core/trigger-source.js";
import { HaClient, type ClientOptions } from "./client.js";
import { readHomeAssistantConfig, type HomeAssistantConfig } from "./config.js";
import { homeAssistantTriggerSources } from "./event-triggers.js";
import { homeAssistantSdkRuntime } from "./sdk-runtime.js";

export class HomeAssistantAdapter implements BackendAdapter<HomeAssistantConfig> {
  readonly id = "home-assistant";
  readonly readConfig = readHomeAssistantConfig;
  private client: HaClient | undefined;

  /** `options` tune the connection (backoff, timeouts); used by tests. */
  constructor(private readonly options: ClientOptions = {}) {}

  async start(config: HomeAssistantConfig, signal: AbortSignal, log?: Logger): Promise<void> {
    signal.throwIfAborted();
    if (!log) throw new Error("The Home Assistant adapter needs a logger");
    const client = new HaClient(config, log, this.options);
    this.client = client;
    const onAbort = (): void => void client.stop();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await client.start();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    signal.throwIfAborted();
  }

  async stop(): Promise<void> {
    await this.client?.stop();
  }

  status(): BackendStatus {
    return this.client?.status() ?? { connected: false, details: {} };
  }

  onStatusChange(callback: (connected: boolean) => void): Disposable {
    return this.started().onStatusChange(callback);
  }

  site(): SiteInfo | undefined {
    return this.client?.site();
  }

  onSiteChange(callback: () => void): Disposable {
    return this.started().onSiteChange(callback);
  }

  triggerSources(context: AdapterContext): TriggerSources {
    return homeAssistantTriggerSources(this.started(), {
      clock: context.clock,
      firedHolds: context.firedHolds,
    });
  }

  sdkRuntime(context: AdapterContext): SdkRuntime {
    return homeAssistantSdkRuntime(this.started(), context.clock, context.log, {
      dryRun: context.dryRun,
    });
  }

  private started(): HaClient {
    if (!this.client) throw new Error("The Home Assistant adapter has not been started");
    return this.client;
  }
}
