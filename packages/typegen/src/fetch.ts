// Fetches states, services and the version from Home Assistant over its WebSocket API, with
// Node's built-in WebSocket: authenticate, send three commands, close.

import type { ServicesInput, StateInput, TypingsInput } from "./generate.js";

export interface FetchOptions {
  /** Base URL such as `http://homeassistant.local:8123` (the WebSocket URL is derived). */
  url: string;
  token: string;
  timeoutMs?: number;
}

/** `http(s)://host[:port][/path]` → `ws(s)://host[:port][/path]/api/websocket`. */
export function websocketUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === "ws:" || url.protocol === "wss:") return url.toString();
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/websocket`;
  return url.toString();
}

export async function fetchTypingsInput(options: FetchOptions): Promise<TypingsInput> {
  const socket = new WebSocket(websocketUrl(options.url));
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const result = new Promise<TypingsInput>((resolve, reject) => {
    const timer = setTimeout(
      () => fail(new Error("Timed out talking to Home Assistant")),
      options.timeoutMs ?? 30_000,
    );
    const fail = (err: Error): void => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    };
    const command = <T>(type: string): Promise<T> =>
      new Promise<T>((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
        socket.send(JSON.stringify({ id, type }));
      });

    socket.addEventListener("error", () =>
      fail(new Error(`Cannot connect to ${websocketUrl(options.url)}`)),
    );
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (msg.type === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: options.token }));
      } else if (msg.type === "auth_invalid") {
        fail(new Error("Home Assistant rejected the access token"));
      } else if (msg.type === "auth_ok") {
        Promise.all([
          command<StateInput[]>("get_states"),
          command<ServicesInput>("get_services"),
          command<{ version?: string }>("get_config"),
        ]).then(([states, services, config]) => {
          clearTimeout(timer);
          socket.close();
          resolve({ states, services, ...(config.version ? { version: config.version } : {}) });
        }, fail);
      } else if (msg.type === "result" && typeof msg.id === "number") {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.success) waiter?.resolve(msg.result);
        else {
          const error = msg.error as { message?: string } | undefined;
          waiter?.reject(new Error(error?.message ?? "Command failed"));
        }
      }
    });
  });
  return result;
}
