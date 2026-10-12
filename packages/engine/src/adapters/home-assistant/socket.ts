// Opening a WebSocket to Home Assistant and completing the auth handshake
// (auth_required → auth → auth_ok | auth_invalid), on Node's native WebSocket.

import type { Logger } from "../../core/logger.js";

/** Home Assistant rejected the access token. */
export class AuthInvalidError extends Error {
  constructor(message: string) {
    super(`Home Assistant rejected the access token: ${message}`);
    this.name = "AuthInvalidError";
  }
}

/** The socket could not be opened, closed during the handshake, or the handshake timed out. */
export class ConnectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectError";
  }
}

export interface AuthenticatedSocket {
  ws: WebSocket;
  haVersion: string;
}

export interface OpenOptions {
  wsUrl: string;
  token: string;
  log: Logger;
  signal?: AbortSignal;
  /** Maximum time for connect + handshake. Default 10 s. */
  timeoutMs?: number;
}

/**
 * Opens a socket and authenticates. Resolves with the open socket once Home Assistant sent
 * `auth_ok`; rejects with AuthInvalidError or ConnectError. The returned socket's message
 * listeners from the handshake are removed.
 */
export function openAuthenticatedSocket(options: OpenOptions): Promise<AuthenticatedSocket> {
  const { wsUrl, token, log, signal, timeoutMs = 10_000 } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason);
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      return reject(new ConnectError(`Cannot open ${wsUrl}: ${String(err)}`, { cause: err }));
    }

    let settled = false;
    const finish = (err: Error | undefined, result?: AuthenticatedSocket): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
      if (err) {
        ws.close();
        reject(err);
      } else if (result) {
        resolve(result);
      }
    };

    const timer = setTimeout(
      () => finish(new ConnectError(`Timed out connecting to ${wsUrl} after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const onAbort = (): void => finish(signal?.reason as Error);
    const onError = (): void => finish(new ConnectError(`Cannot connect to ${wsUrl}`));
    const onClose = (ev: CloseEvent): void =>
      finish(
        new ConnectError(`Connection to ${wsUrl} closed during authentication (code ${ev.code})`),
      );

    const onMessage = (ev: MessageEvent): void => {
      let msg: { type?: string; ha_version?: string; message?: string };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return finish(new ConnectError("Received invalid JSON during authentication"));
      }
      log.trace({ received: msg }, "Home Assistant auth message");
      if (msg.type === "auth_required") {
        const auth = { type: "auth", access_token: token };
        log.trace({ sent: auth }, "Sending auth");
        ws.send(JSON.stringify(auth));
      } else if (msg.type === "auth_ok") {
        finish(undefined, { ws, haVersion: msg.ha_version ?? "unknown" });
      } else if (msg.type === "auth_invalid") {
        finish(new AuthInvalidError(msg.message ?? "auth_invalid"));
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}
