// Writes to Home Assistant (ha-actions: Call services, Service response data, Unawaited
// write errors are reported). Every write is attributed to the calling rule (change cause,
// logs) and registered with the safety net, so a failing write nobody awaited is logged as
// a failed write of that rule instead of an anonymous unhandled rejection.

import { logDryRun } from "../../core/dry-run.js";
import { currentRun, invoke, requireRun } from "../../core/run-context.js";
import { trackWrite } from "../../core/safety-net.js";
import type { Logger } from "../../core/logger.js";
import type { RuleScopeImpl } from "../../core/rule-scope.js";
import { trackedServiceCall } from "./attribution.js";
import { HaRestError, type HaClient } from "./client.js";
import { HaCommandError, HaDisconnectedError } from "./session.js";
import type { HaState } from "./types.js";

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
  /** Creates or updates a virtual entity; republished after Home Assistant restarts. */
  setState(
    entity: string,
    state: string | number | boolean,
    attributes?: Record<string, unknown>,
  ): Promise<void>;
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

/** A JSON round-tripped copy of `data`, or a TypeError naming the function. */
function jsonData(
  fn: string,
  what: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  } catch (err) {
    throw new TypeError(`${fn}(): ${what} must be JSON-serialisable (${(err as Error).message})`, {
      cause: err,
    });
  }
}

/** The last value a loaded rule set for a virtual entity. */
interface VirtualEntity {
  scope: RuleScopeImpl;
  state: string;
  attributes: Record<string, unknown>;
  release: () => void;
}

export interface WritesOptions {
  /** Log outgoing service calls, events and state writes instead of sending them. */
  dryRun?: boolean;
}

export function createWrites(
  client: HaClient,
  log: Logger,
  { dryRun = false }: WritesOptions = {},
): Writes {
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
    if (dryRun) {
      logDryRun(ruleLog, ruleId, service, { service, target, data });
      return Promise.resolve(options.returnResponse ? {} : undefined);
    }

    const promise = (async () => {
      const session = client.connection.current;
      if (!session || !client.isReady) {
        throw new NotConnectedError(service);
      }
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
        if (err instanceof HaCommandError) {
          throw new ServiceCallError(service, err.code, haMessage(err));
        }
        if (err instanceof HaDisconnectedError) {
          throw new NotConnectedError(service);
        }
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

  /**
   * Registers a helper's own promise with the safety net, described like the service call it
   * makes (`light.turn_on → light.porch`). The inner call() promise is awaited by the helper,
   * so a failure is reported once, for the promise the rule actually dropped.
   */
  const tracked = (service: (entity: string) => string, entity: unknown, run: Promise<void>) =>
    trackWrite(
      run,
      typeof entity === "string" && ENTITY_ID.test(entity)
        ? `${service(entity)} → ${entity}`
        : String(entity),
    );

  const switchTo = (fn: string, target: "on" | "off", force: boolean) => {
    const service = (entity: string): string =>
      serviceFor(entity, target === "on" ? "turn_on" : "turn_off");
    const run = async (entity: string, data: Record<string, unknown>): Promise<void> => {
      checkEntity(fn, entity);
      if (!force && client.states.get(entity)?.state === target) {
        caller().log.debug({ entity }, `${fn}(${entity}) skipped: already ${target}`);
        return;
      }
      await call(service(entity), data, { entity_id: entity });
    };
    return (entity: string, data: Record<string, unknown> = {}): Promise<void> =>
      tracked(service, entity, run(entity, data));
  };

  const position = (fn: "up" | "down", defaultPosition: number) => {
    const run = async (cover: string, target: number): Promise<void> => {
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
    return (cover: string, target = defaultPosition): Promise<void> =>
      tracked(() => "cover.set_cover_position", cover, run(cover, target));
  };

  const toggle = (entity: string): Promise<void> => {
    const service = (e: string): string => serviceFor(e, "toggle");
    const run = async (): Promise<void> => {
      checkEntity("toggle", entity);
      await call(service(entity), {}, { entity_id: entity });
    };
    return tracked(service, entity, run());
  };

  function fire(eventType: string, data: Record<string, unknown> = {}): Promise<void> {
    if (typeof eventType !== "string" || !/^[a-z0-9_.]+$/i.test(eventType)) {
      throw new TypeError(`fire(): ${JSON.stringify(eventType)} is not an event type`);
    }
    const payload = jsonData("fire", "the event data", data);
    const { ruleId, log: ruleLog } = caller();
    if (dryRun) {
      logDryRun(ruleLog, ruleId, `fire ${eventType}`, { eventType, data: payload });
      return Promise.resolve();
    }
    const promise = (async () => {
      const session = client.connection.current;
      if (!session || !client.isReady) {
        throw new NotConnectedError(`fire ${eventType}`);
      }
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
        if (err instanceof HaCommandError) {
          throw new ServiceCallError(`fire ${eventType}`, err.code, haMessage(err));
        }
        if (err instanceof HaDisconnectedError) {
          throw new NotConnectedError(`fire ${eventType}`);
        }
        throw err;
      }
    })();
    return trackWrite(promise, `fire ${eventType}`);
  }

  // Virtual entities (ha-actions: Set virtual entity state). Home Assistant forgets states
  // set over REST when it restarts, so the last value per entity is kept while the rule
  // that set it is loaded, and published again on every reconnect. Nothing is persisted
  // across engine restarts.
  const virtualEntities = new Map<string, VirtualEntity>();

  const publishState = async (
    ruleId: string,
    entity: string,
    state: string,
    attributes: Record<string, unknown>,
  ): Promise<void> => {
    const what = `setState ${entity}`;
    if (!client.isReady) {
      throw new NotConnectedError(what);
    }
    try {
      await client.attribution.track(ruleId, () =>
        client.rest<HaState>("POST", `/states/${encodeURIComponent(entity)}`, {
          state,
          attributes,
        }),
      );
    } catch (err) {
      if (err instanceof HaRestError) {
        throw new ServiceCallError(what, `http_${err.status}`, err.haMessage);
      }
      throw err;
    }
  };

  /** Remembers the value for republishing; the latest writer owns the entity. */
  const remember = (
    scope: RuleScopeImpl,
    entity: string,
    state: string,
    attributes: Record<string, unknown>,
  ): void => {
    const known = virtualEntities.get(entity);
    if (known?.scope === scope) {
      known.state = state;
      known.attributes = attributes;
      return;
    }
    known?.release();
    const release = scope.onDispose(() => {
      if (virtualEntities.get(entity)?.scope === scope) {
        virtualEntities.delete(entity);
      }
    });
    virtualEntities.set(entity, { scope, state, attributes, release });
  };

  function setState(
    entity: string,
    state: string | number | boolean,
    attributes: Record<string, unknown> = {},
  ): Promise<void> {
    checkEntity("setState", entity);
    if (!["string", "number", "boolean"].includes(typeof state)) {
      throw new TypeError(`setState(): the state must be a string, number or boolean`);
    }
    const value = String(state);
    const attrs = jsonData("setState", "the attributes", attributes);
    const { ruleId, log: ruleLog } = caller();
    if (dryRun) {
      logDryRun(ruleLog, ruleId, `setState ${entity}`, {
        entity,
        state: value,
        attributes: attrs,
      });
      return Promise.resolve();
    }
    const run = currentRun();
    if (run) {
      remember(run.scope, entity, value, attrs);
    }
    ruleLog.debug({ entity, state: value, attributes: attrs }, `Setting ${entity} to ${value}`);
    return trackWrite(publishState(ruleId, entity, value, attrs), `setState ${entity}`);
  }

  client.onReady(() => {
    if (virtualEntities.size === 0) {
      return;
    }
    log.info({ count: virtualEntities.size }, "Republishing virtual entities");
    for (const [entity, v] of virtualEntities) {
      publishState(v.scope.ruleId, entity, v.state, v.attributes).catch((err: unknown) =>
        v.scope.log.warn({ err, entity }, `Republishing ${entity} failed`),
      );
    }
  });

  const ws = {
    async command<T = unknown>(message: Record<string, unknown> & { type: string }): Promise<T> {
      if (!message || typeof message.type !== "string") {
        throw new TypeError(
          'ws.command(): the message needs a "type", e.g. { type: "config/entity_registry/list" }',
        );
      }
      const session = client.connection.current;
      if (!session || !client.isReady) {
        throw new NotConnectedError(message.type);
      }
      const { id: _ignored, ...rest } = message as Record<string, unknown> & { type: string };
      void _ignored;
      return session.command<T>(rest as Record<string, unknown> & { type: string });
    },
  };

  /** Registers a status callback for the calling rule; released on unload. */
  const statusListener =
    (fn: string, wanted: boolean) => (callback: () => void | Promise<void>) => {
      if (typeof callback !== "function") {
        throw new TypeError(`connection.${fn}(): the callback must be a function`);
      }
      const run = requireRun(`connection.${fn}`);
      const sub = client.onStatusChange((connected) => {
        if (connected === wanted) {
          invoke(run.scope, "callback", () => callback());
        }
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
    setState,
    ws,
    connection,
    on: switchTo("on", "on", false),
    off: switchTo("off", "off", false),
    forceOn: switchTo("forceOn", "on", true),
    forceOff: switchTo("forceOff", "off", true),
    toggle,
    up: position("up", 100),
    down: position("down", 0),
  };
}

/** Home Assistant's own message, without the session's "<command> failed:" prefix. */
function haMessage(err: HaCommandError): string {
  return err.message.replace(/^\S+ failed: /, "").replace(/ \([^)]*\)$/, "");
}
