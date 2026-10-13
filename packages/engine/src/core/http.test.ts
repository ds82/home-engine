import { afterEach, describe, expect, it } from "vitest";
import type { BackendStatus } from "./adapter.js";
import { HttpServer, LAG_LIMIT_MS, type StatusSources } from "./http.js";
import { RuleRegistry, type RuleInfo } from "./rule-registry.js";
import { RuleScopeImpl } from "./rule-scope.js";
import { invoke } from "./run-context.js";
import { logCapture } from "./testing/log-capture.js";
import { FakeSources } from "./testing/fake-sources.js";
import { scopedTimers } from "./timers.js";

const rule = (overrides: Partial<RuleInfo>): RuleInfo => ({
  id: "lights/porch.ts#porch",
  name: "porch",
  file: "lights/porch.ts",
  kind: "triggered",
  description: undefined,
  status: "running",
  disabledBy: undefined,
  loadedAt: new Date("2026-10-11T08:00:00Z"),
  lastRunAt: undefined,
  lastError: undefined,
  triggerErrors: [],
  nextRun: undefined,
  nextRuns: [],
  activeTriggers: 1,
  scheduledTimers: 0,
  ...overrides,
});

describe("HTTP endpoints", () => {
  let server: HttpServer | undefined;
  let backend: BackendStatus = { connected: true, details: { haVersion: "2026.10.0" } };
  let loaded = true;
  let lag = 0;
  let rules: RuleInfo[] = [];

  const sources: StatusSources = {
    backend: () => backend,
    initialLoadDone: () => loaded,
    rules: () => rules,
    engine: () => ({ version: "0.1.0", watchMode: "native" }),
  };

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    backend = { connected: true, details: { haVersion: "2026.10.0" } };
    loaded = true;
    lag = 0;
    rules = [];
  });

  async function start(): Promise<string> {
    server = new HttpServer(8080, sources, logCapture([]).log, {
      host: "127.0.0.1",
      eventLoopLag: () => lag,
    });
    const port = await server.start(0);
    return `http://127.0.0.1:${port}`;
  }

  const get = async (url: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(url);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("reports liveness while Home Assistant is unreachable", async () => {
    const base = await start();
    backend = { connected: false, details: {} };
    expect(await get(`${base}/health/live`)).toEqual({
      status: 200,
      body: { status: "ok", eventLoopLagMs: 0 },
    });
  });

  it("fails liveness after the event loop was blocked too long", async () => {
    const base = await start();
    lag = LAG_LIMIT_MS + 1_000;
    expect((await get(`${base}/health/live`)).status).toBe(503);
  });

  it("is ready when connected and the initial load completed", async () => {
    const base = await start();
    expect(await get(`${base}/health/ready`)).toEqual({
      status: 200,
      body: { ready: true, connected: true, rulesLoaded: true, haVersion: "2026.10.0" },
    });
  });

  it("is not ready while reconnecting or before the initial load", async () => {
    const base = await start();
    backend = { connected: false, details: {} };
    expect(await get(`${base}/health/ready`)).toMatchObject({
      status: 503,
      body: { ready: false, connected: false },
    });
    backend = { connected: true, details: {} };
    loaded = false;
    expect(await get(`${base}/health/ready`)).toMatchObject({
      status: 503,
      body: { ready: false, connected: true, rulesLoaded: false },
    });
  });

  it("lists a setup rule as starting while it sets up, and stays ready", async () => {
    const registry = new RuleRegistry({
      sources: new FakeSources().sources,
      log: logCapture([]).log,
    });
    let release: () => void = () => {};
    // A file added by hot reload after the initial load.
    const loading = registry.loadFile("slow.ts", [
      {
        kind: "setup",
        id: "slow#setup",
        name: "setup",
        file: "slow.ts",
        options: {},
        fn: () => new Promise<void>((r) => (release = r)),
      },
    ]);
    const base = await start();
    rules = registry.listRules();
    expect((await get(`${base}/rules`)).body.rules).toEqual([
      expect.objectContaining({ id: "slow#setup", status: "starting" }),
    ]);
    expect((await get(`${base}/health/ready`)).status).toBe(200);
    release();
    await loading;
    rules = registry.listRules();
    expect((await get(`${base}/rules`)).body.rules).toEqual([
      expect.objectContaining({ id: "slow#setup", status: "running" }),
    ]);
  });

  it("lists rules with status, errors and counts, plus engine metadata", async () => {
    const base = await start();
    rules = [
      rule({ scheduledTimers: 2, nextRun: new Date("2026-10-11T09:00:00Z") }),
      rule({
        id: "climate.ts#heating",
        status: "failed",
        lastError: "ReferenceError: foo is not defined",
        activeTriggers: 0,
      }),
      rule({
        id: "alarm.ts#siren",
        triggerErrors: [
          {
            kind: "ha-trigger",
            position: 2,
            trigger: "ha-trigger nope",
            message: "Invalid platform: nope",
          },
        ],
      }),
    ];
    const { status, body } = await get(`${base}/rules`);
    expect(status).toBe(200);
    expect(body.engine).toEqual({ version: "0.1.0", watchMode: "native" });
    expect(body.rules).toEqual([
      expect.objectContaining({
        id: "lights/porch.ts#porch",
        file: "lights/porch.ts",
        status: "running",
        loadedAt: "2026-10-11T08:00:00.000Z",
        activeTriggers: 1,
        scheduledTimers: 2,
        nextRun: "2026-10-11T09:00:00.000Z",
      }),
      expect.objectContaining({
        id: "climate.ts#heating",
        status: "failed",
        lastError: "ReferenceError: foo is not defined",
      }),
      expect.objectContaining({
        id: "alarm.ts#siren",
        status: "running",
        triggerErrors: [
          {
            kind: "ha-trigger",
            position: 2,
            trigger: "ha-trigger nope",
            message: "Invalid platform: nope",
          },
        ],
      }),
    ]);
  });

  it("answers unknown paths with 404 and writes with 405", async () => {
    const base = await start();
    expect((await get(`${base}/states`)).status).toBe(404);
    expect((await fetch(`${base}/rules`, { method: "POST" })).status).toBe(405);
  });

  it("opens no port with HTTP_PORT=0", async () => {
    server = new HttpServer(0, sources, logCapture([]).log);
    expect(await server.start()).toBeUndefined();
  });

  it("counts a rule's pending native timers", async () => {
    const scope = new RuleScopeImpl("timers#rule", logCapture([]).log);
    let interval: ReturnType<typeof setInterval> | undefined;
    await invoke(scope, "body", () => {
      scopedTimers.setTimeout(() => {}, 60_000);
      interval = scopedTimers.setInterval(() => {}, 60_000);
    }).done;
    expect(scope.activeTimers).toBe(2);
    scopedTimers.clearInterval(interval);
    expect(scope.activeTimers).toBe(1);
    await scope.dispose();
    expect(scope.activeTimers).toBe(0);
  });
});
