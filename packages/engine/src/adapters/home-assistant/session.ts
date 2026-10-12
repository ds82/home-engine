// One authenticated WebSocket to Home Assistant: message IDs, request/response correlation
// with per-request timeouts, and routing of subscription events by ID. A session lives as
// long as its socket; reconnecting creates a new session.

import type { Logger } from "../../core/logger.js";

/** Home Assistant answered a command with `success: false`. */
export class HaCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly command: string,
  ) {
    super(`${command} failed: ${message} (${code})`);
    this.name = "HaCommandError";
  }
}

/** No response arrived within the request's timeout. */
export class HaTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} timed out after ${timeoutMs} ms`);
    this.name = "HaTimeoutError";
  }
}

/** The connection closed before the response arrived, or was already closed. */
export class HaDisconnectedError extends Error {
  constructor(readonly command: string) {
    super(`${command} failed: not connected to Home Assistant`);
    this.name = "HaDisconnectedError";
  }
}

export type HaMessage = Record<string, unknown> & { type: string };
export type EventHandler = (event: unknown) => void;

interface Pending {
  command: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SessionOptions {
  log: Logger;
  /** Default per-request timeout. Default 30 s. */
  timeoutMs?: number;
}

export class HaSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Map<number, EventHandler>();
  private readonly closeListeners = new Set<() => void>();
  private open = true;
  private readonly log: Logger;
  private readonly timeoutMs: number;

  constructor(
    private readonly ws: WebSocket,
    options: SessionOptions,
  ) {
    this.log = options.log;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    ws.addEventListener("message", (ev) => this.onMessage(ev));
    ws.addEventListener("close", () => this.handleClose());
    if (ws.readyState !== WebSocket.OPEN) {
      this.handleClose();
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Sends a command and resolves with its `result` (or on `pong` for pings). Rejects with
   * HaCommandError, HaTimeoutError or HaDisconnectedError.
   */
  command<T = unknown>(msg: HaMessage, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.send<T>(msg, options).promise;
  }

  /**
   * Sends a subscribing command (e.g. `subscribe_events`) and routes the subscription's
   * `event` messages to `onEvent`. Resolves with the subscription ID once confirmed; on
   * failure no handler stays registered.
   */
  async subscribe(
    msg: HaMessage,
    onEvent: EventHandler,
    options: { timeoutMs?: number } = {},
  ): Promise<number> {
    const { id, promise } = this.send(msg, options);
    this.eventHandlers.set(id, onEvent);
    try {
      await promise;
    } catch (err) {
      this.eventHandlers.delete(id);
      throw err;
    }
    return id;
  }

  /** Stops routing events of a subscription and tells Home Assistant to end it. */
  async unsubscribe(subscriptionId: number): Promise<void> {
    if (!this.eventHandlers.delete(subscriptionId)) {
      return;
    }
    if (!this.open) {
      return;
    }
    await this.command({ type: "unsubscribe_events", subscription: subscriptionId });
  }

  /** Calls `listener` once when the session closes (immediately if it already has). */
  onClose(listener: () => void): void {
    if (this.open) {
      this.closeListeners.add(listener);
    } else {
      listener();
    }
  }

  /** Closes the socket; pending requests are rejected. */
  close(): void {
    this.ws.close();
    this.handleClose();
  }

  private handleClose(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HaDisconnectedError(p.command));
    }
    this.pending.clear();
    this.eventHandlers.clear();
    for (const listener of [...this.closeListeners]) {
      listener();
    }
    this.closeListeners.clear();
  }

  private send<T>(
    msg: HaMessage,
    options: { timeoutMs?: number },
  ): { id: number; promise: Promise<T> } {
    const id = this.nextId++;
    const command = msg.type;
    if (!this.open || this.ws.readyState !== WebSocket.OPEN) {
      return { id, promise: Promise.reject(new HaDisconnectedError(command)) };
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.eventHandlers.delete(id);
        reject(new HaTimeoutError(command, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        command,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
    });
    const payload = { ...msg, id };
    this.log.trace({ sent: payload }, "→ Home Assistant");
    this.ws.send(JSON.stringify(payload));
    return { id, promise };
  }

  private onMessage(ev: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(ev.data));
    } catch {
      this.log.warn("Ignoring invalid JSON from Home Assistant");
      return;
    }
    // Home Assistant may coalesce several messages into one JSON array.
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      this.dispatch(msg as Record<string, unknown>);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    this.log.trace({ received: msg }, "← Home Assistant");
    const id = msg.id;
    if (typeof id !== "number") {
      return;
    }

    if (msg.type === "event") {
      const handler = this.eventHandlers.get(id);
      if (handler) {
        handler(msg.event);
      }
      return;
    }

    if (msg.type !== "result" && msg.type !== "pong") {
      return;
    }
    const p = this.pending.get(id);
    if (!p) {
      return;
    } // Late answer after a timeout, or not ours.
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.type === "pong" || msg.success === true) {
      p.resolve(msg.type === "pong" ? undefined : msg.result);
    } else {
      const error = (msg.error ?? {}) as { code?: string; message?: string };
      this.eventHandlers.delete(id);
      p.reject(
        new HaCommandError(
          error.code ?? "unknown_error",
          error.message ?? "unknown error",
          p.command,
        ),
      );
    }
  }
}
