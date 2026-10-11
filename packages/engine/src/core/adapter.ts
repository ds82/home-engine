// The seam between the backend-neutral core and a smart-home backend (design D13).
// The core only ever talks to backends through this interface; Home Assistant is the first
// implementation. Adapters may import from core, never the other way round.

import type { ConfigReader } from "./config.js";
import type { RuleScope } from "./rule-scope.js";

/** Something that can be released, such as a subscription. */
export interface Disposable {
  dispose(): void;
}

/** The location context a backend provides; schedules and sun times are computed from it. */
export interface SiteInfo {
  /** IANA time zone, e.g. `Europe/Berlin`. */
  timeZone: string;
  latitude: number;
  longitude: number;
  /** Metres above sea level. */
  elevation: number;
  /** Unit names by quantity, e.g. `{ temperature: "°C" }`. */
  units: Record<string, string>;
}

export interface BackendStatus {
  connected: boolean;
  /** Backend-specific details for the readiness endpoint (version, reconnect attempts, ...). */
  details: Record<string, unknown>;
}

export interface BackendAdapter<Config = unknown, RuleApi extends object = object> {
  /** Stable identifier, e.g. `"home-assistant"`. */
  readonly id: string;

  /** Reads the adapter's own environment variables, reported through core's fail-fast validation. */
  readonly readConfig: ConfigReader<Config>;

  /**
   * Connects. Resolves after the first successful connection and initial sync; keeps
   * retrying on network errors until then. Aborting `signal` gives up.
   */
  start(config: Config, signal: AbortSignal): Promise<void>;

  /** Disconnects and releases everything; no callbacks fire afterwards. */
  stop(): Promise<void>;

  status(): BackendStatus;
  onStatusChange(callback: (connected: boolean) => void): Disposable;

  /** The current Site, or `undefined` before the first connection. */
  site(): SiteInfo | undefined;
  onSiteChange(callback: () => void): Disposable;

  /**
   * Creates the backend-specific SDK functions for one started rule. Every subscription they
   * make registers its disposer with `scope`, so unloading the rule releases it.
   */
  createRuleApi(scope: RuleScope): RuleApi;
}
