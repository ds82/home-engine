// Wires the Home Assistant connection, subscription registry and state cache together.
// On every (re)connect: replay subscriptions, then load states, then report ready.

import type { BackendStatus, Disposable, SiteInfo } from "../../core/adapter.js";
import type { Logger } from "../../core/logger.js";
import type { HomeAssistantConfig } from "./config.js";
import { HaConnection, type ConnectionOptions } from "./connection.js";
import type { HaSession } from "./session.js";
import { StateCache } from "./state-cache.js";
import { WriteAttribution } from "./attribution.js";
import { StateDispatcher } from "./state-triggers.js";
import { SubscriptionRegistry } from "./subscriptions.js";

export type ClientOptions = Omit<ConnectionOptions, "config" | "log"> & {
  /** HTTP client for the REST API. Injectable for tests. */
  fetch?: typeof fetch;
};

/** Timeout of a REST request. */
export const REST_TIMEOUT_MS = 10_000;

/** A REST request was answered with an error status. */
export class HaRestError extends Error {
  constructor(
    readonly status: number,
    readonly haMessage: string,
  ) {
    super(`HTTP ${status}: ${haMessage}`);
    this.name = "HaRestError";
  }
}

/** The parts of Home Assistant's `get_config` result the engine uses. */
export interface HaCoreConfig {
  version: string;
  time_zone: string;
  latitude: number;
  longitude: number;
  elevation: number;
  location_name?: string;
  unit_system?: Record<string, string>;
}

export interface HaUser {
  id: string;
  name?: string;
  is_admin?: boolean;
}

export function siteFromConfig(config: HaCoreConfig): SiteInfo {
  return {
    timeZone: config.time_zone,
    latitude: config.latitude,
    longitude: config.longitude,
    elevation: config.elevation,
    units: { ...config.unit_system },
  };
}

export class HaClient {
  readonly connection: HaConnection;
  readonly subscriptions: SubscriptionRegistry;
  readonly states: StateCache;
  /** Routes state changes to armed state triggers. */
  readonly dispatcher: StateDispatcher;
  /** Remembers which rule made which write, for change cause. */
  readonly attribution: WriteAttribution;
  private ready = false;
  private firstReady: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  private readonly readyListeners = new Set<() => void>();
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private readonly siteListeners = new Set<() => void>();
  private coreConfig: HaCoreConfig | undefined;
  private serviceIndex: Map<string, Set<string>> | undefined;
  private user: HaUser | undefined;
  private currentSite: SiteInfo | undefined;

  private readonly fetch: typeof fetch;

  constructor(
    private readonly endpoint: HomeAssistantConfig,
    private readonly log: Logger,
    options: ClientOptions = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.connection = new HaConnection({ ...options, config: endpoint, log });
    this.subscriptions = new SubscriptionRegistry(log);
    this.states = new StateCache(this.subscriptions, log);
    this.attribution = new WriteAttribution({ engineUserId: () => this.userId });
    this.dispatcher = new StateDispatcher(this.states, this.attribution);
    this.connection.onSession((session) => void this.initialise(session));
    this.connection.onDisconnect(() => this.setReady(false));
    // Location or time zone edited in Home Assistant: refresh the Site.
    // Integrations loaded or unloaded: refresh the known services.
    for (const eventType of ["service_registered", "service_removed"]) {
      this.subscriptions.onEvent(eventType, () => {
        const session = this.connection.current;
        if (session) {
          void this.loadServices(session).catch((err: unknown) =>
            this.log.warn({ err }, "Reloading the Home Assistant services failed"),
          );
        }
      });
    }
    this.subscriptions.onEvent("core_config_updated", () => {
      const session = this.connection.current;
      if (session)
        void this.loadConfig(session).catch((err: unknown) =>
          this.log.warn({ err }, "Reloading the Home Assistant config failed"),
        );
    });
  }

  /** Home Assistant's core config from the latest connect. */
  get config(): HaCoreConfig | undefined {
    return this.coreConfig;
  }

  /** The user the engine authenticated as; writes by it count as engine-caused. */
  get userId(): string | undefined {
    return this.user?.id;
  }

  status(): BackendStatus {
    return {
      connected: this.ready,
      details: {
        haVersion: this.connection.version,
        userId: this.user?.id,
        entities: this.states.size,
        subscriptions: this.subscriptions.size,
      },
    };
  }

  /** Called with `true` when the client becomes ready and `false` when the connection is lost. */
  onStatusChange(listener: (connected: boolean) => void): Disposable {
    this.statusListeners.add(listener);
    return { dispose: () => this.statusListeners.delete(listener) };
  }

  site(): SiteInfo | undefined {
    return this.currentSite;
  }

  onSiteChange(listener: () => void): Disposable {
    this.siteListeners.add(listener);
    return { dispose: () => this.siteListeners.delete(listener) };
  }

  /** True while connected and fully synchronised. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Called each time the client becomes ready (after the first connect and every reconnect). */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  /** Connects and resolves once subscriptions and states are loaded for the first time. */
  async start(): Promise<void> {
    const first = new Promise<void>((resolve, reject) => {
      this.firstReady = { resolve, reject };
    });
    // stop() while still connecting rejects `first`, also if the connection never resolves.
    await Promise.race([this.connection.start().then(() => first), first]);
  }

  async stop(): Promise<void> {
    this.firstReady?.reject(new Error("Stopped before connecting to Home Assistant"));
    this.firstReady = undefined;
    await this.connection.stop();
    this.setReady(false);
    this.dispatcher.dispose();
    this.states.dispose();
    this.statusListeners.clear();
    this.siteListeners.clear();
  }

  private async initialise(session: HaSession): Promise<void> {
    try {
      await this.subscriptions.attach(session);
      await Promise.all([
        this.states.sync(session),
        this.loadConfig(session),
        this.loadServices(session),
        session.command<HaUser>({ type: "auth/current_user" }).then((user) => {
          this.user = user;
        }),
      ]);
    } catch (err) {
      // The session failed mid-initialisation; the connection reconnects and we retry.
      this.log.warn({ err }, "Initialising the Home Assistant session failed");
      return;
    }
    if (!session.isOpen) return;
    this.setReady(true);
    this.firstReady?.resolve();
    this.firstReady = undefined;
    for (const listener of [...this.readyListeners]) listener();
  }

  /**
   * Sends a REST request (`path` relative to the REST base URL, which is
   * `http://supervisor/core/api` in Supervisor mode) and resolves with the JSON reply.
   */
  async rest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.endpoint.restUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.endpoint.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text || res.statusText;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Not JSON: keep the raw text.
      }
      throw new HaRestError(res.status, message);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Services by domain from the latest get_services; undefined before the first connect. */
  get services(): ReadonlyMap<string, ReadonlySet<string>> | undefined {
    return this.serviceIndex;
  }

  /** True when Home Assistant offers `domain.service` (unknown before the first connect). */
  hasService(domain: string, service: string): boolean | undefined {
    return this.serviceIndex ? (this.serviceIndex.get(domain)?.has(service) ?? false) : undefined;
  }

  private async loadServices(session: HaSession): Promise<void> {
    const result = await session.command<Record<string, Record<string, unknown>>>({
      type: "get_services",
    });
    this.serviceIndex = new Map(
      Object.entries(result).map(([domain, services]) => [domain, new Set(Object.keys(services))]),
    );
  }

  private async loadConfig(session: HaSession): Promise<void> {
    const config = await session.command<HaCoreConfig>({ type: "get_config" });
    this.coreConfig = config;
    const site = siteFromConfig(config);
    const changed =
      this.currentSite !== undefined && JSON.stringify(site) !== JSON.stringify(this.currentSite);
    this.currentSite = site;
    if (changed) {
      this.log.info({ site }, "Home Assistant location settings changed");
      for (const listener of [...this.siteListeners]) listener();
    }
  }

  /** Notifies status listeners on every transition, never twice for the same state. */
  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    for (const listener of [...this.statusListeners]) {
      try {
        listener(ready);
      } catch (err) {
        this.log.error({ err }, "Connection status listener threw");
      }
    }
  }
}
