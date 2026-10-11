// The engine's single, long-lived connection to Home Assistant (ha-connection spec):
// waits for Home Assistant at startup, reconnects forever with exponential backoff and
// jitter, and hands every new authenticated session to its listeners.

import { setTimeout as sleep } from "node:timers/promises";
import { FatalError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import type { HomeAssistantConfig } from "./config.js";
import { HaSession, HaTimeoutError } from "./session.js";
import { AuthInvalidError, openAuthenticatedSocket } from "./socket.js";

export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/**
 * Delay before reconnect attempt `attempt` (0-based): 1 s doubling up to 60 s, with up to
 * 20 % jitter downwards so many engines don't reconnect in lockstep.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.2 * random()));
}

export interface ConnectionOptions {
  config: HomeAssistantConfig;
  log: Logger;
  /** Waits `ms` or rejects when `signal` aborts. Injectable for tests. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Per-request timeout of sessions. */
  requestTimeoutMs?: number;
  /** Timeout for connect + auth handshake. */
  connectTimeoutMs?: number;
  /** Interval between keep-alive pings. Default 30 s. */
  pingIntervalMs?: number;
  /** A ping without pong within this time marks the connection dead. Default 10 s. */
  pongTimeoutMs?: number;
}

export const PING_INTERVAL_MS = 30_000;
export const PONG_TIMEOUT_MS = 10_000;

export type SessionListener = (
  session: HaSession,
  info: { haVersion: string; reconnect: boolean },
) => void;

export class HaConnection {
  private session: HaSession | undefined;
  private haVersion: string | undefined;
  private readonly controller = new AbortController();
  private readonly sessionListeners = new Set<SessionListener>();
  private readonly disconnectListeners = new Set<() => void>();
  private connectedOnce = false;
  private loop: Promise<void> | undefined;
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: ConnectionOptions) {
    this.delay = options.delay ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    this.random = options.random ?? Math.random;
  }

  /** The current session, if connected. */
  get current(): HaSession | undefined {
    return this.session?.isOpen ? this.session : undefined;
  }

  get version(): string | undefined {
    return this.haVersion;
  }

  /** Called with every new session (first connect and each reconnect). */
  onSession(listener: SessionListener): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** Called when an established session is lost. */
  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /**
   * Connects, retrying network errors with backoff until Home Assistant is reachable.
   * Resolves after the first successful connection; afterwards the connection is kept up
   * in the background. An invalid token on this first connection rejects with FatalError.
   */
  start(): Promise<void> {
    if (this.loop) throw new Error("HaConnection already started");
    return new Promise<void>((resolve, reject) => {
      this.loop = this.run(resolve, reject);
    });
  }

  /** Closes the connection and stops reconnecting. */
  async stop(): Promise<void> {
    this.controller.abort(new Error("Home Assistant connection stopped"));
    this.session?.close();
    await this.loop?.catch(() => undefined);
  }

  /**
   * Pings the session periodically. A missing pong means a half-open connection (e.g. the
   * network dropped silently): the session is closed, which starts the reconnect.
   */
  private keepAlive(session: HaSession): void {
    const { log } = this.options;
    const interval = this.options.pingIntervalMs ?? PING_INTERVAL_MS;
    const timeoutMs = this.options.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    const timer = setInterval(() => {
      session.command({ type: "ping" }, { timeoutMs }).catch((err: unknown) => {
        if (!(err instanceof HaTimeoutError) || !session.isOpen) return;
        log.warn(
          { timeoutMs },
          "Home Assistant did not answer a ping; treating the connection as dead",
        );
        session.close();
      });
    }, interval);
    timer.unref();
    session.onClose(() => clearInterval(timer));
  }

  private async run(onFirstConnect: () => void, onFatal: (err: unknown) => void): Promise<void> {
    const { log, config } = this.options;
    const signal = this.controller.signal;
    let attempt = 0;
    let authFailing = false;

    while (!signal.aborted) {
      try {
        const { ws, haVersion } = await openAuthenticatedSocket({
          wsUrl: config.wsUrl,
          token: config.token,
          log,
          signal,
          ...(this.options.connectTimeoutMs ? { timeoutMs: this.options.connectTimeoutMs } : {}),
        });
        const session = new HaSession(ws, {
          log,
          ...(this.options.requestTimeoutMs ? { timeoutMs: this.options.requestTimeoutMs } : {}),
        });
        const reconnect = this.connectedOnce;
        this.session = session;
        this.haVersion = haVersion;
        this.connectedOnce = true;
        attempt = 0;
        authFailing = false;
        log.info(
          { haVersion, url: config.wsUrl },
          reconnect
            ? `Reconnected to Home Assistant ${haVersion}`
            : `Connected to Home Assistant ${haVersion}`,
        );
        const closed = new Promise<void>((r) => session.onClose(r));
        this.keepAlive(session);
        for (const listener of [...this.sessionListeners])
          listener(session, { haVersion, reconnect });
        if (!reconnect) onFirstConnect();

        await closed;
        if (signal.aborted) return;
        log.warn("Lost connection to Home Assistant; reconnecting");
        for (const listener of [...this.disconnectListeners]) listener();
        // Fall through to the backoff delay: even after a drop we never reconnect in a
        // tight loop, in case Home Assistant accepts and immediately drops connections.
      } catch (err) {
        if (signal.aborted) {
          if (!this.connectedOnce) onFatal(err);
          return;
        }
        if (err instanceof AuthInvalidError) {
          if (!this.connectedOnce) {
            log.error(
              { url: config.wsUrl, reason: err.message },
              "Authentication with Home Assistant failed; check HA_TOKEN",
            );
            onFatal(new FatalError(err.message, 1, { cause: err }));
            return;
          }
          log.error(
            { url: config.wsUrl, reason: err.message },
            "Home Assistant rejected the access token on reconnect; retrying at the maximum interval",
          );
          authFailing = true;
        } else {
          log.debug({ err: String(err), attempt }, "Connecting to Home Assistant failed");
          if (attempt === 0) {
            log.warn(
              { url: config.wsUrl, reason: (err as Error).message },
              "Home Assistant is not reachable; retrying",
            );
          }
        }
      }

      const wait = authFailing
        ? backoffDelay(Infinity, this.random)
        : backoffDelay(attempt, this.random);
      attempt++;
      try {
        await this.delay(wait, signal);
      } catch {
        if (!this.connectedOnce) onFatal(signal.reason);
        return;
      }
    }
  }
}
