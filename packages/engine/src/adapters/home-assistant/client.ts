// Wires the Home Assistant connection, subscription registry and state cache together.
// On every (re)connect: replay subscriptions, then load states, then report ready.

import type { Logger } from "../../core/logger.js";
import type { HomeAssistantConfig } from "./config.js";
import { HaConnection, type ConnectionOptions } from "./connection.js";
import type { HaSession } from "./session.js";
import { StateCache } from "./state-cache.js";
import { SubscriptionRegistry } from "./subscriptions.js";

export type ClientOptions = Omit<ConnectionOptions, "config" | "log">;

export class HaClient {
  readonly connection: HaConnection;
  readonly subscriptions: SubscriptionRegistry;
  readonly states: StateCache;
  private ready = false;
  private firstReady: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  private readonly readyListeners = new Set<() => void>();

  constructor(
    config: HomeAssistantConfig,
    private readonly log: Logger,
    options: ClientOptions = {},
  ) {
    this.connection = new HaConnection({ ...options, config, log });
    this.subscriptions = new SubscriptionRegistry(log);
    this.states = new StateCache(this.subscriptions, log);
    this.connection.onSession((session) => void this.initialise(session));
    this.connection.onDisconnect(() => {
      this.ready = false;
    });
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
    await this.connection.start();
    await first;
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.connection.stop();
    this.states.dispose();
  }

  private async initialise(session: HaSession): Promise<void> {
    try {
      await this.subscriptions.attach(session);
      await this.states.sync(session);
    } catch (err) {
      // The session failed mid-initialisation; the connection reconnects and we retry.
      this.log.warn({ err }, "Initialising the Home Assistant session failed");
      return;
    }
    if (!session.isOpen) return;
    this.ready = true;
    this.firstReady?.resolve();
    this.firstReady = undefined;
    for (const listener of [...this.readyListeners]) listener();
  }
}
