// The seam between the backend-neutral core and a smart-home backend (design D13).
// The core only ever talks to backends through this interface; Home Assistant is the first
// implementation. Adapters may import from core, never the other way round.

import type { ConfigReader } from "./config.js";
import type { FiredHolds } from "./fired-holds.js";
import type { Logger } from "./logger.js";
import type { SdkRuntime } from "./sdk-runtime.js";
import type { Clock } from "./timer.js";
import type { TriggerSources } from "./trigger-source.js";

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

/** What the core hands an adapter once it is connected. */
export interface AdapterContext {
  log: Logger;
  clock: Clock;
  /** The record of fired holds, for hold restoration of state triggers. */
  firedHolds: FiredHolds;
  /** DRY_RUN: log outgoing writes instead of sending them. */
  dryRun: boolean;
}

export interface BackendAdapter<Config = unknown> {
  /** Stable identifier, e.g. `"home-assistant"`. */
  readonly id: string;

  /** Reads the adapter's own environment variables, reported through core's fail-fast validation. */
  readonly readConfig: ConfigReader<Config>;

  /**
   * Connects. Resolves after the first successful connection and initial sync; keeps
   * retrying on network errors until then. Aborting `signal` gives up.
   */
  start(config: Config, signal: AbortSignal, log?: Logger): Promise<void>;

  /** Disconnects and releases everything; no callbacks fire afterwards. */
  stop(): Promise<void>;

  status(): BackendStatus;
  onStatusChange(callback: (connected: boolean) => void): Disposable;

  /** The current Site, or `undefined` before the first connection. */
  site(): SiteInfo | undefined;
  onSiteChange(callback: () => void): Disposable;

  /** Trigger sources for the backend's trigger kinds (e.g. `state`, `event`); after start. */
  triggerSources(context: AdapterContext): TriggerSources;

  /**
   * The backend's SDK functions (e.g. `on`, `call`), merged into the SDK runtime; after start.
   * They find the calling rule through the run context, and every subscription they make
   * registers its disposer with that rule's scope, so unloading the rule releases it.
   */
  sdkRuntime(context: AdapterContext): SdkRuntime;
}
