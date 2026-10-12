// HTTP endpoints (engine-observability; design D10): three read-only GET routes on node:http.
//   /health/live   200 while the event loop is responsive (503 after a block longer than
//                  LAG_LIMIT_MS, so Docker restarts a container stuck in a rule's loop)
//   /health/ready  200 when connected to the backend and the initial load completed, else 503
//   /rules         every known rule with status, errors and counts, plus engine metadata
// No secrets, entity states or rule source code are exposed. HTTP_PORT=0 disables the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { BackendStatus } from "./adapter.js";
import type { Logger } from "./logger.js";
import type { RuleInfo } from "./rule-registry.js";

/** Event-loop blocks longer than this make liveness fail. */
export const LAG_LIMIT_MS = 5_000;
/** How often the event-loop delay is sampled (and its maximum reset). */
const LAG_WINDOW_MS = 5_000;

export interface StatusSources {
  backend(): BackendStatus;
  /** True once the initial rule load has completed. */
  initialLoadDone(): boolean;
  rules(): RuleInfo[];
  /** Engine metadata for /rules, e.g. version and watch mode. */
  engine(): Record<string, unknown>;
}

export interface HttpServerOptions {
  /** Interface to bind; default all. */
  host?: string;
  /** The longest recent event-loop block in ms; injectable for tests. */
  eventLoopLag?: () => number;
}

/** Measures the longest event-loop block of the last window. */
function eventLoopLagMonitor(): { lag: () => number; stop: () => void } {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastWindowMax = 0;
  const timer = setInterval(() => {
    lastWindowMax = histogram.max / 1e6;
    histogram.reset();
  }, LAG_WINDOW_MS);
  timer.unref();
  return {
    lag: () => Math.max(lastWindowMax, histogram.max / 1e6),
    stop: () => {
      clearInterval(timer);
      histogram.disable();
    },
  };
}

export class HttpServer {
  private server: Server | undefined;
  private monitor: { lag: () => number; stop: () => void } | undefined;

  constructor(
    private readonly port: number,
    private readonly sources: StatusSources,
    private readonly log: Logger,
    private readonly options: HttpServerOptions = {},
  ) {}

  /**
   * Starts listening and resolves with the bound port, or undefined when disabled
   * (`port` 0). Pass `listenPort` to bind another port, e.g. a free one in tests.
   */
  async start(listenPort = this.port): Promise<number | undefined> {
    if (this.port === 0) {
      this.log.info("HTTP server disabled (HTTP_PORT=0)");
      return undefined;
    }
    if (!this.options.eventLoopLag) {
      this.monitor = eventLoopLagMonitor();
    }
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    this.log.info({ port }, `HTTP server listening on port ${port}`);
    return port;
  }

  async stop(): Promise<void> {
    this.monitor?.stop();
    this.monitor = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private lag(): number {
    return this.options.eventLoopLag?.() ?? this.monitor?.lag() ?? 0;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(`${JSON.stringify(body, null, 2)}\n`);
    };
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const routes: Record<string, () => void> = {
      "/health/live": () => {
        const eventLoopLagMs = Math.round(this.lag());
        const ok = eventLoopLagMs <= LAG_LIMIT_MS;
        send(ok ? 200 : 503, { status: ok ? "ok" : "event loop blocked", eventLoopLagMs });
      },
      "/health/ready": () => {
        const { connected, details } = this.sources.backend();
        const rulesLoaded = this.sources.initialLoadDone();
        const ready = connected && rulesLoaded;
        send(ready ? 200 : 503, { ready, connected, rulesLoaded, ...details });
      },
      "/rules": () => {
        send(200, { engine: this.sources.engine(), rules: this.sources.rules().map(ruleJson) });
      },
    };
    const route = routes[path];
    if (!route) {
      return send(404, { error: "not found", routes: Object.keys(routes) });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      return send(405, { error: "method not allowed" });
    }
    try {
      route();
    } catch (err) {
      this.log.error({ err, path }, "HTTP status request failed");
      send(500, { error: "internal error" });
    }
  }
}

/** A rule's public status (no source code, no states). */
function ruleJson(rule: RuleInfo): Record<string, unknown> {
  return {
    id: rule.id,
    name: rule.name,
    file: rule.file,
    kind: rule.kind,
    description: rule.description,
    status: rule.status,
    disabledBy: rule.disabledBy,
    loadedAt: rule.loadedAt.toISOString(),
    lastRunAt: rule.lastRunAt?.toISOString(),
    lastError: rule.lastError,
    activeTriggers: rule.activeTriggers,
    scheduledTimers: rule.scheduledTimers,
    triggerErrors: rule.triggerErrors,
    nextRun: rule.nextRun?.toISOString(),
    nextRuns: rule.nextRuns.map((n) => ({ kind: n.kind, nextRun: n.nextRun.toISOString() })),
  };
}
