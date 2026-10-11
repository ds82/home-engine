// Writes to Home Assistant (ha-actions: Call services, Service response data, Unawaited
// write errors are reported). Every write is attributed to the calling rule (change cause,
// logs) and registered with the safety net, so a failing write nobody awaited is logged as
// a failed write of that rule instead of an anonymous unhandled rejection.

import { currentRun, invoke, requireRun } from "../../core/run-context.js";
import { trackWrite } from "../../core/safety-net.js";
import type { Logger } from "../../core/logger.js";
import { trackedServiceCall } from "./attribution.js";
import type { HaClient } from "./client.js";
import { HaCommandError, HaDisconnectedError } from "./session.js";

export interface ServiceTarget {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
  label_id?: string | string[];
}

export interface CallOptions {
  /** Ask the service for response data and resolve with it. */
  returnResponse?: boolean;
}

/** A write failed in Home Assistant; carries its error code. */
export class ServiceCallError extends Error {
  constructor(
    readonly service: string,
    readonly code: string,
    readonly haMessage: string,
  ) {
    super(`${service} failed: ${haMessage} (${code})`);
    this.name = "ServiceCallError";
  }
}

/** The engine is not connected to Home Assistant; writes are not queued. */
export class NotConnectedError extends Error {
  constructor(what: string) {
    super(`${what}: not connected to Home Assistant`);
    this.name = "NotConnectedError";
  }
}

const SERVICE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export interface Writes {
  call(
    service: string,
    data?: Record<string, unknown>,
    target?: ServiceTarget,
    options?: CallOptions,
  ): Promise<unknown>;
  on(entity: string, data?: Record<string, unknown>): Promise<void>;
  off(entity: string, data?: Record<string, unknown>): Promise<void>;
  forceOn(entity: string, data?: Record<string, unknown>): Promise<void>;
  forceOff(entity: string, data?: Record<string, unknown>): Promise<void>;
  toggle(entity: string): Promise<void>;
  up(cover: string, position?: number): Promise<void>;
  down(cover: string, position?: number): Promise<void>;
  fire(eventType: string, data?: Record<string, unknown>): Promise<void>;
  /** Raw WebSocket access for features the engine does not wrap. */
  ws: { command<T = unknown>(message: Record<string, unknown> & { type: string }): Promise<T> };
  /** Connection status and notifications for rules. */
  connection: {
    isConnected(): boolean;
    onConnect(callback: () => void | Promise<void>): { cancel(): void };
    onDisconnect(callback: () => void | Promise<void>): { cancel(): void };
  };
}

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

function checkEntity(fn: string, entity: unknown): string {
  if (typeof entity !== "string" || !ENTITY_ID.test(entity)) {
    throw new TypeError(`${fn}(): ${JSON.stringify(entity)} is not an entity ID`);
  }
  return entity;
}

export function createWrites(client: HaClient, log: Logger): Writes {
  /** The calling rule (or "-" outside rule code) and its logger. */
  const caller = (): { ruleId: string; log: Logger } => {
    const run = currentRun();
    return run ? { ruleId: run.scope.ruleId, log: run.scope.log } : { ruleId: "-", log };
  };

  function call(
    service: string,
    data: Record<string, unknown> = {},
    target?: ServiceTarget,
    options: CallOptions = {},
  ): Promise<unknown> {
    if (typeof service !== "string" || !SERVICE.test(service)) {
      throw new TypeError(
        `call(): ${JSON.stringify(service)} is not a service name like "light.turn_on"`,
      );
    }
    const [domain = "", name = ""] = service.split(".");
    const { ruleId, log: ruleLog } = caller();
    const description = `${service}${target?.entity_id ? ` → ${[target.entity_id].flat().join(", ")}` : ""}`;

    const promise = (async () => {
      const session = client.connection.current;
      if (!session || !client.isReady) throw new NotConnectedError(service);
      ruleLog.debug({ service, target, data }, `Calling ${description}`);
      try {
        const result = await trackedServiceCall(client.attribution, session, ruleId, {
          domain,
          service: name,
          service_data: data,
          ...(target ? { target: target as Record<string, unknown> } : {}),
          ...(options.returnResponse ? { return_response: true } : {}),
        });
        return options.returnResponse ? result.response : undefined;
      } catch (err) {
        if (err instanceof HaCommandError)
          throw new ServiceCallError(service, err.code, haMessage(err));
        if (err instanceof HaDisconnectedError) throw new NotConnectedError(service);
        throw err;
      }
    })();
    return trackWrite(promise, description);
  }

  /** The domain's own service, or homeassistant.* when Home Assistant reports the domain lacks it. */
  const serviceFor = (entity: string, service: "turn_on" | "turn_off" | "toggle"): string => {
    const domain = entity.split(".")[0] ?? "";
    return client.hasService(domain, service) === false
      ? `homeassistant.${service}`
      : `${domain}.${service}`;
  };

  const switchTo =
    (fn: string, target: "on" | "off", force: boolean) =>
    async (entity: string, data: Record<string, unknown> = {}): Promise<void> => {
      checkEntity(fn, entity);
      if (!force && client.states.get(entity)?.state === target) {
        caller().log.debug({ entity }, `${fn}(${entity}) skipped: already ${target}`);
        return;
      }
      await call(serviceFor(entity, target === "on" ? "turn_on" : "turn_off"), data, {
        entity_id: entity,
      });
    };

  const position =
    (fn: "up" | "down", defaultPosition: number) =>
    async (cover: string, target = defaultPosition): Promise<void> => {
      checkEntity(fn, cover);
      if (!Number.isFinite(target) || target < 0 || target > 100) {
        throw new TypeError(`${fn}(): position must be between 0 (closed) and 100 (open)`);
      }
      const current = client.states.get(cover)?.attributes.current_position;
      if (typeof current === "number" && (fn === "up" ? current >= target : current <= target)) {
        caller().log.debug({ cover, current, target }, `${fn}(${cover}) skipped: at ${current}`);
        return;
      }
      await call("cover.set_cover_position", { position: target }, { entity_id: cover });
    };

  function fire(eventType: string, data: Record<string, unknown> = {}): Promise<void> {
    if (typeof eventType !== "string" || !/^[a-z0-9_.]+$/i.test(eventType)) {
      throw new TypeError(`fire(): ${JSON.stringify(eventType)} is not an event type`);
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    } catch (err) {
      throw new TypeError(
        `fire(): the event data must be JSON-serialisable (${(err as Error).message})`,
        {
          cause: err,
        },
      );
    }
    const { ruleId, log: ruleLog } = caller();
    const promise = (async () => {
      const session = client.connection.current;
      if (!session || !client.isReady) throw new NotConnectedError(`fire ${eventType}`);
      ruleLog.debug({ eventType, data: payload }, `Firing ${eventType}`);
      try {
        await client.attribution.track(ruleId, () =>
          session.command<{
            context?: { id: string; parent_id: string | null; user_id: string | null };
          }>({
            type: "fire_event",
            event_type: eventType,
            event_data: payload,
          }),
        );
      } catch (err) {
        if (err instanceof HaCommandError)
          throw new ServiceCallError(`fire ${eventType}`, err.code, haMessage(err));
        if (err instanceof HaDisconnectedError) throw new NotConnectedError(`fire ${eventType}`);
        throw err;
      }
    })();
    return trackWrite(promise, `fire ${eventType}`);
  }

  const ws = {
    async command<T = unknown>(message: Record<string, unknown> & { type: string }): Promise<T> {
      if (!message || typeof message.type !== "string") {
        throw new TypeError(
          'ws.command(): the message needs a "type", e.g. { type: "config/entity_registry/list" }',
        );
      }
      const session = client.connection.current;
      if (!session || !client.isReady) throw new NotConnectedError(message.type);
      const { id: _ignored, ...rest } = message as Record<string, unknown> & { type: string };
      void _ignored;
      return session.command<T>(rest as Record<string, unknown> & { type: string });
    },
  };

  /** Registers a status callback for the calling rule; released on unload. */
  const statusListener =
    (fn: string, wanted: boolean) => (callback: () => void | Promise<void>) => {
      if (typeof callback !== "function")
        throw new TypeError(`connection.${fn}(): the callback must be a function`);
      const run = requireRun(`connection.${fn}`);
      const sub = client.onStatusChange((connected) => {
        if (connected === wanted) invoke(run.scope, "callback", () => callback());
      });
      const remove = run.scope.onDispose(() => sub.dispose());
      return {
        cancel: () => {
          sub.dispose();
          remove();
        },
      };
    };

  const connection = {
    isConnected: () => client.isReady,
    onConnect: statusListener("onConnect", true),
    onDisconnect: statusListener("onDisconnect", false),
  };

  return {
    call,
    fire,
    ws,
    connection,
    on: switchTo("on", "on", false),
    off: switchTo("off", "off", false),
    forceOn: switchTo("forceOn", "on", true),
    forceOff: switchTo("forceOff", "off", true),
    toggle: async (entity) => {
      checkEntity("toggle", entity);
      await call(serviceFor(entity, "toggle"), {}, { entity_id: entity });
    },
    up: position("up", 100),
    down: position("down", 0),
  };
}

/** Home Assistant's own message, without the session's "<command> failed:" prefix. */
function haMessage(err: HaCommandError): string {
  return err.message.replace(/^\S+ failed: /, "").replace(/ \([^)]*\)$/, "");
}
