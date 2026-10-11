// A scriptable stand-in for Home Assistant's WebSocket API, used by our tests.
// It speaks the real wire protocol (auth handshake, result/event/pong messages) and keeps
// a small in-memory model of states, services, history and statistics. Tests drive it
// through the public methods (setState, pushEvent, dropConnections, ...) and inspect what
// clients sent through `calls` and `received`.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { HaContext, HaState } from "../types.js";

export type { HaContext, HaState } from "../types.js";

export interface HaConfig {
  version: string;
  time_zone: string;
  latitude: number;
  longitude: number;
  elevation: number;
  location_name: string;
  unit_system: Record<string, string>;
  [key: string]: unknown;
}

export interface ServiceCall {
  domain: string;
  service: string;
  service_data: Record<string, unknown>;
  target: Record<string, unknown> | undefined;
  return_response: boolean;
  context: HaContext;
}

/** What a service handler returns: optional response data for `return_response` calls. */
/** A service's field descriptions as `get_services` reports them. */
export interface ServiceDescription {
  fields: Record<string, unknown>;
}

export type ServiceHandler = (
  call: ServiceCall,
  server: MockHomeAssistant,
) => ServiceOutcome | Promise<ServiceOutcome>;

/** Response data for `return_response` calls, or `undefined` for none. */
export type ServiceOutcome = { response?: unknown } | undefined;

export interface StatisticRow {
  start: number;
  end: number;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  state?: number | null;
  change?: number | null;
}

export interface TriggerSubscription {
  /** The subscription ID (the `id` of the `subscribe_trigger` message). */
  id: number;
  trigger: unknown;
  socket: WebSocket;
}

/** Result of a command handler: either a result payload or an error. */
export type CommandOutcome =
  | { result: unknown }
  | { error: { code: string; message: string } }
  /** The handler already replied (or deliberately never replies). */
  | { handled: true };

export type CommandHandler = (
  msg: Record<string, unknown> & { id: number; type: string },
  conn: MockConnection,
) => CommandOutcome | Promise<CommandOutcome>;

export interface MockHomeAssistantOptions {
  /** Tokens accepted during auth. Default: `["test-token"]`. */
  tokens?: string[];
  /** Home Assistant version reported in `auth_required`/`auth_ok`/`get_config`. */
  version?: string;
  /** User ID reported by `auth/current_user` and set on contexts of client writes. */
  userId?: string;
  config?: Partial<HaConfig>;
  /** Clock used for timestamps. Default: `Date.now`. */
  now?: () => number;
  /** Interface to listen on; default 127.0.0.1 (0.0.0.0 to serve other containers). */
  host?: string;
}

interface Subscription {
  id: number;
  socket: WebSocket;
  eventType: string | undefined;
}

/** One authenticated or authenticating client connection. */
export class MockConnection {
  authenticated = false;
  constructor(
    readonly socket: WebSocket,
    readonly server: MockHomeAssistant,
  ) {}

  send(msg: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}

export function newContext(
  userId: string | null = null,
  parentId: string | null = null,
): HaContext {
  return {
    id: randomUUID().replaceAll("-", "").slice(0, 26),
    parent_id: parentId,
    user_id: userId,
  };
}

export class MockHomeAssistant {
  readonly version: string;
  readonly userId: string;
  config: HaConfig;

  /** Every service call received, in order. */
  readonly calls: ServiceCall[] = [];
  /** Every message received from clients after authentication, in order. */
  readonly received: Array<Record<string, unknown>> = [];

  /** When false, `ping` messages are swallowed (simulates a half-open connection). */
  respondToPing = true;
  /**
   * When true, the `state_changed` events caused by a service call are sent before the
   * call's result message (Home Assistant does this sometimes).
   */
  stateChangesBeforeResult = false;
  /** Validates `subscribe_trigger` configs; return an error message to reject. */
  validateTrigger: (trigger: unknown) => string | undefined = () => undefined;

  private readonly tokens: Set<string>;
  private readonly now: () => number;
  private readonly states = new Map<string, HaState>();
  private readonly history = new Map<string, HaState[]>();
  private readonly statistics = new Map<string, StatisticRow[]>();
  private readonly services = new Map<string, ServiceHandler>();
  private readonly serviceDescriptions = new Map<string, ServiceDescription>();
  private readonly commands = new Map<string, CommandHandler>();
  private readonly subscriptions = new Map<WebSocket, Map<number, Subscription>>();
  private readonly triggers = new Map<WebSocket, Map<number, TriggerSubscription>>();
  private readonly connections = new Set<MockConnection>();
  private readonly connectionWaiters: Array<(conn: MockConnection) => void> = [];

  private readonly host: string;
  private http: Server | undefined;
  private wss: WebSocketServer | undefined;
  private listenPort = 0;

  constructor(options: MockHomeAssistantOptions = {}) {
    this.tokens = new Set(options.tokens ?? ["test-token"]);
    this.host = options.host ?? "127.0.0.1";
    this.version = options.version ?? "2026.10.0";
    this.userId = options.userId ?? "engine-user-id";
    this.now = options.now ?? Date.now;
    this.config = {
      version: this.version,
      time_zone: "Europe/Berlin",
      latitude: 52.52,
      longitude: 13.405,
      elevation: 34,
      location_name: "Home",
      unit_system: { length: "km", mass: "g", temperature: "°C", volume: "L" },
      ...options.config,
    };
    this.registerBuiltinCommands();
    this.registerBuiltinServices();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts listening. Without a port, a free one is chosen; `start()` after `stop()` reuses it. */
  async start(port = this.listenPort): Promise<void> {
    if (this.http) return;
    const http = createServer((req, res) => void this.onHttp(req, res));
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, this.host, () => resolve());
    });
    this.listenPort = (http.address() as AddressInfo).port;
    this.http = http;
    this.wss = wss;
  }

  /** Stops listening and terminates all connections (simulates Home Assistant going down). */
  async stop(): Promise<void> {
    this.dropConnections();
    const { http, wss } = this;
    this.http = undefined;
    this.wss = undefined;
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  }

  get port(): number {
    return this.listenPort;
  }

  /** Base URL in the form users configure (`http://host:port`). */
  get url(): string {
    return `http://127.0.0.1:${this.listenPort}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.listenPort}/api/websocket`;
  }

  /** Number of currently open client connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Resolves with the next client that completes authentication. */
  waitForConnection(): Promise<MockConnection> {
    return new Promise((resolve) => this.connectionWaiters.push(resolve));
  }

  /** Abruptly terminates every client connection, without a close handshake. */
  dropConnections(): void {
    for (const conn of this.connections) conn.socket.terminate();
    this.connections.clear();
    this.subscriptions.clear();
    this.triggers.clear();
  }

  setTokens(tokens: string[]): void {
    this.tokens.clear();
    for (const t of tokens) this.tokens.add(t);
  }

  // --------------------------------------------------------------------- REST

  /** REST requests received, in order (method, path, parsed JSON body). */
  readonly restRequests: Array<{ method: string; path: string; body: unknown }> = [];

  /** Handles the REST API subset the engine uses: `POST /api/states/<entity_id>`. */
  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const path = req.url ?? "/";
    const reply = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      reply(400, { message: "Invalid JSON specified." });
      return;
    }
    this.restRequests.push({ method: req.method ?? "GET", path, body });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token || !this.tokens.has(token)) {
      reply(401, { message: "401: Unauthorized" });
      return;
    }
    const match = /^\/api\/states\/([^/?]+)$/.exec(path);
    if (req.method !== "POST" || !match?.[1]) {
      reply(404, { message: "Not found" });
      return;
    }
    const entityId = decodeURIComponent(match[1]);
    const { state, attributes } = (body ?? {}) as { state?: unknown; attributes?: unknown };
    if (typeof state !== "string") {
      reply(400, { message: "No state specified." });
      return;
    }
    const existed = this.states.has(entityId);
    const next = this.setState(entityId, state, (attributes ?? {}) as Record<string, unknown>, {
      context: newContext(this.userId),
    });
    reply(existed ? 200 : 201, next);
  }

  // ------------------------------------------------------------------- states

  getState(entityId: string): HaState | undefined {
    return this.states.get(entityId);
  }

  getStates(): HaState[] {
    return [...this.states.values()];
  }

  /**
   * Sets an entity's state, records it in history and sends `state_changed` to subscribers.
   * `last_changed` only moves when the state value changes, as in Home Assistant.
   */
  setState(
    entityId: string,
    state: string,
    attributes?: Record<string, unknown>,
    options: { context?: HaContext; at?: number; silent?: boolean } = {},
  ): HaState {
    const old = this.states.get(entityId);
    const at = new Date(options.at ?? this.now()).toISOString();
    const next: HaState = {
      entity_id: entityId,
      state,
      attributes: attributes ?? old?.attributes ?? {},
      last_changed: old && old.state === state ? old.last_changed : at,
      last_updated: at,
      context: options.context ?? newContext(),
    };
    this.states.set(entityId, next);
    let hist = this.history.get(entityId);
    if (!hist) this.history.set(entityId, (hist = []));
    hist.push(next);
    if (!options.silent) this.emitStateChanged(old, next);
    return next;
  }

  /** Removes an entity and sends `state_changed` with `new_state: null`. */
  removeState(entityId: string, options: { context?: HaContext; silent?: boolean } = {}): void {
    const old = this.states.get(entityId);
    if (!old) return;
    this.states.delete(entityId);
    if (!options.silent) this.emitStateChanged(old, null, options.context);
  }

  /** Replaces the history of an entity (used by `history/history_during_period`). */
  setHistory(entityId: string, states: HaState[]): void {
    this.history.set(entityId, [...states]);
  }

  setStatistics(statisticId: string, rows: StatisticRow[]): void {
    this.statistics.set(statisticId, [...rows]);
  }

  // ------------------------------------------------------------------- events

  /** Sends a bus event to every matching `subscribe_events` subscriber. */
  pushEvent(
    eventType: string,
    data: Record<string, unknown> = {},
    options: { origin?: string; context?: HaContext } = {},
  ): void {
    const event = {
      event_type: eventType,
      data,
      origin: options.origin ?? "LOCAL",
      time_fired: new Date(this.now()).toISOString(),
      context: options.context ?? newContext(),
    };
    for (const subs of this.subscriptions.values()) {
      for (const sub of subs.values()) {
        if (sub.eventType === undefined || sub.eventType === eventType) {
          this.sendTo(sub.socket, { id: sub.id, type: "event", event });
        }
      }
    }
  }

  /** All active `subscribe_trigger` subscriptions. */
  /** Active `subscribe_events` subscriptions, with their event type (undefined = all). */
  eventSubscriptions(): Array<{ id: number; eventType: string | undefined }> {
    return [...this.subscriptions.values()].flatMap((m) =>
      [...m.values()].map(({ id, eventType }) => ({ id, eventType })),
    );
  }

  triggerSubscriptions(): TriggerSubscription[] {
    return [...this.triggers.values()].flatMap((m) => [...m.values()]);
  }

  /** Fires a native trigger subscription with the given trigger variables. */
  fireTrigger(sub: TriggerSubscription, variables: Record<string, unknown>): void {
    this.sendTo(sub.socket, {
      id: sub.id,
      type: "event",
      event: { variables: { trigger: variables }, context: newContext() },
    });
  }

  // ----------------------------------------------------------------- handlers

  /** Registers (or replaces) the handler for `domain.service`. */
  onService(
    domain: string,
    service: string,
    handler: ServiceHandler,
    description: ServiceDescription = { fields: {} },
  ): void {
    this.services.set(`${domain}.${service}`, handler);
    this.serviceDescriptions.set(`${domain}.${service}`, description);
  }

  /** Registers (or replaces) the handler for a WebSocket command type. */
  onCommand(type: string, handler: CommandHandler): void {
    this.commands.set(type, handler);
  }

  // ---------------------------------------------------------------- internals

  private onConnection(socket: WebSocket): void {
    const conn = new MockConnection(socket, this);
    this.connections.add(conn);
    socket.on("close", () => {
      this.connections.delete(conn);
      this.subscriptions.delete(socket);
      this.triggers.delete(socket);
    });
    socket.on("message", (raw) => void this.onMessage(conn, raw));
    conn.send({ type: "auth_required", ha_version: this.version });
  }

  private async onMessage(conn: MockConnection, raw: RawData): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      conn.socket.close(1002, "invalid JSON");
      return;
    }

    if (!conn.authenticated) {
      if (msg.type !== "auth") return;
      const token = msg.access_token;
      if (typeof token === "string" && this.tokens.has(token)) {
        conn.authenticated = true;
        conn.send({ type: "auth_ok", ha_version: this.version });
        this.connectionWaiters.splice(0).forEach((resolve) => resolve(conn));
      } else {
        conn.send({ type: "auth_invalid", message: "Invalid access token or password" });
        conn.socket.close();
      }
      return;
    }

    this.received.push(msg);
    const { id, type } = msg;
    if (typeof id !== "number" || typeof type !== "string") return;

    if (type === "ping") {
      if (this.respondToPing) conn.send({ id, type: "pong" });
      return;
    }

    const handler = this.commands.get(type);
    const outcome: CommandOutcome = handler
      ? await handler({ ...msg, id, type }, conn)
      : { error: { code: "unknown_command", message: `Unknown command: ${type}` } };
    if ("handled" in outcome) return;
    if ("error" in outcome) conn.send({ id, type: "result", success: false, error: outcome.error });
    else conn.send({ id, type: "result", success: true, result: outcome.result });
  }

  private sendTo(socket: WebSocket, msg: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  private emitStateChanged(
    old: HaState | undefined,
    next: HaState | null,
    context?: HaContext,
  ): void {
    this.pushEvent(
      "state_changed",
      { entity_id: (next ?? old)?.entity_id, old_state: old ?? null, new_state: next },
      { context: next?.context ?? context ?? newContext() },
    );
  }

  private registerBuiltinCommands(): void {
    this.onCommand("get_states", () => ({ result: this.getStates() }));
    this.onCommand("get_config", () => ({ result: this.config }));
    this.onCommand("get_services", () => {
      const result: Record<string, Record<string, ServiceDescription & { name: string }>> = {};
      for (const key of this.services.keys()) {
        const [domain = "", service = ""] = key.split(".");
        const description = this.serviceDescriptions.get(key) ?? { fields: {} };
        (result[domain] ??= {})[service] = { name: service, ...description };
      }
      return { result };
    });
    this.onCommand("auth/current_user", () => ({
      result: { id: this.userId, name: "home-engine", is_owner: false, is_admin: true },
    }));

    this.onCommand("subscribe_events", (msg, conn) => {
      const eventType = typeof msg.event_type === "string" ? msg.event_type : undefined;
      this.subsFor(conn.socket).set(msg.id, { id: msg.id, socket: conn.socket, eventType });
      return { result: null };
    });

    this.onCommand("unsubscribe_events", (msg, conn) => {
      const subId = msg.subscription as number;
      const removed =
        this.subscriptions.get(conn.socket)?.delete(subId) ||
        this.triggers.get(conn.socket)?.delete(subId);
      return removed
        ? { result: null }
        : { error: { code: "not_found", message: "Subscription not found." } };
    });

    this.onCommand("subscribe_trigger", (msg, conn) => {
      const error = this.validateTrigger(msg.trigger);
      if (error) return { error: { code: "invalid_format", message: error } };
      let map = this.triggers.get(conn.socket);
      if (!map) this.triggers.set(conn.socket, (map = new Map()));
      map.set(msg.id, { id: msg.id, trigger: msg.trigger, socket: conn.socket });
      return { result: null };
    });

    this.onCommand("fire_event", (msg) => {
      const context = newContext(this.userId);
      this.pushEvent(msg.event_type as string, (msg.event_data as Record<string, unknown>) ?? {}, {
        context,
      });
      return { result: { context } };
    });

    this.onCommand("call_service", async (msg, conn) => {
      const call: ServiceCall = {
        domain: msg.domain as string,
        service: msg.service as string,
        service_data: (msg.service_data as Record<string, unknown>) ?? {},
        target: msg.target as Record<string, unknown> | undefined,
        return_response: msg.return_response === true,
        context: newContext(this.userId),
      };
      this.calls.push(call);
      const handler = this.services.get(`${call.domain}.${call.service}`);
      if (!handler) {
        return {
          error: {
            code: "not_found",
            message: `Service ${call.domain}.${call.service} not found.`,
          },
        };
      }
      // Hold back state_changed events emitted by the handler unless they should go first.
      const deferred: Array<() => void> = [];
      const restore = this.stateChangesBeforeResult ? undefined : this.deferEvents(deferred);
      let out: ServiceOutcome;
      try {
        out = await handler(call, this);
      } catch (err) {
        restore?.();
        return { error: { code: "home_assistant_error", message: String(err) } };
      }
      restore?.();
      const result: Record<string, unknown> = { context: call.context };
      if (call.return_response) result.response = out?.response ?? null;
      conn.send({ id: msg.id, type: "result", success: true, result });
      for (const send of deferred) send();
      return { handled: true };
    });

    this.onCommand("history/history_during_period", (msg) => ({
      result: this.historyDuringPeriod(msg),
    }));

    this.onCommand("recorder/statistics_during_period", (msg) => {
      const ids = (msg.statistic_ids as string[]) ?? [];
      const start = Date.parse(msg.start_time as string);
      const end = msg.end_time ? Date.parse(msg.end_time as string) : Infinity;
      const types = msg.types as string[] | undefined;
      const result: Record<string, StatisticRow[]> = {};
      for (const id of ids) {
        const rows = (this.statistics.get(id) ?? []).filter(
          (r) => r.start >= start && r.start < end,
        );
        if (rows.length === 0) continue;
        result[id] = rows.map((r) => pickTypes(r, types));
      }
      return { result };
    });
  }

  /** Default services: `<domain>.turn_on|turn_off|toggle` switch the targeted entities. */
  private registerBuiltinServices(): void {
    const domains = ["light", "switch", "fan", "input_boolean", "homeassistant"];
    for (const domain of domains) {
      for (const service of ["turn_on", "turn_off", "toggle"]) {
        this.onService(domain, service, (call) => {
          for (const entityId of targetEntityIds(call)) {
            const current = this.states.get(entityId);
            const next =
              service === "turn_on"
                ? "on"
                : service === "turn_off"
                  ? "off"
                  : current?.state === "on"
                    ? "off"
                    : "on";
            this.setState(entityId, next, current?.attributes, { context: call.context });
          }
          return undefined;
        });
      }
    }
  }

  private subsFor(socket: WebSocket): Map<number, Subscription> {
    let map = this.subscriptions.get(socket);
    if (!map) this.subscriptions.set(socket, (map = new Map()));
    return map;
  }

  /** Temporarily queues outgoing events instead of sending them; returns the restore function. */
  private deferEvents(queue: Array<() => void>): () => void {
    const original = this.sendTo;
    this.sendTo = (socket, msg) => queue.push(() => original.call(this, socket, msg));
    return () => {
      this.sendTo = original;
    };
  }

  private historyDuringPeriod(msg: Record<string, unknown>): Record<string, unknown[]> {
    const start = Date.parse(msg.start_time as string);
    const end = msg.end_time ? Date.parse(msg.end_time as string) : Infinity;
    const ids = (msg.entity_ids as string[] | undefined) ?? [...this.history.keys()];
    const includeStart = msg.include_start_time_state !== false;
    const noAttributes = msg.no_attributes === true;
    const result: Record<string, unknown[]> = {};
    for (const id of ids) {
      const all = this.history.get(id) ?? [];
      const inRange = all.filter((s) => {
        const t = Date.parse(s.last_updated);
        return t >= start && t < end;
      });
      const before = all.filter((s) => Date.parse(s.last_updated) < start).at(-1);
      const rows = includeStart && before ? [before, ...inRange] : inRange;
      if (rows.length === 0) continue;
      // Compressed format, as returned by Home Assistant's history websocket API.
      result[id] = rows.map((s, i) => {
        const lu = Date.parse(s.last_updated) / 1000;
        const lc = Date.parse(s.last_changed) / 1000;
        const row: Record<string, unknown> = {
          s: s.state,
          lu: i === 0 && s === before ? start / 1000 : lu,
        };
        if (!noAttributes) row.a = s.attributes;
        if (lc !== lu) row.lc = lc;
        return row;
      });
    }
    return result;
  }
}

function targetEntityIds(call: ServiceCall): string[] {
  const raw = call.target?.entity_id ?? call.service_data.entity_id;
  if (raw === undefined) return [];
  return Array.isArray(raw) ? (raw as string[]) : [raw as string];
}

function pickTypes(row: StatisticRow, types: string[] | undefined): StatisticRow {
  if (!types) return row;
  const out: StatisticRow = { start: row.start, end: row.end };
  for (const t of types) {
    const key = t as keyof StatisticRow;
    if (key in row) (out as unknown as Record<string, unknown>)[key] = row[key];
  }
  return out;
}
