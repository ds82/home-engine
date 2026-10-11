// Bootstrap (design D13: the core owns bootstrap and shutdown). The startup sequence is
// config → logger → HTTP (live) → dependencies → storage and fired holds → connect → SDK and
// trigger sources → load rules → watcher → ready. Problems in rule files never stop it;
// invalid configuration does (ConfigError, thrown before anything starts).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext, BackendAdapter } from "./adapter.js";
import { loadConfig, logEffectiveConfig, type Env, type LoadedConfig } from "./config.js";
import { installRuleDependencies } from "./dependencies.js";
import { FiredHolds } from "./fired-holds.js";
import { HotReloader } from "./hot-reload.js";
import { HttpServer } from "./http.js";
import { logLoadSummary, RuleLoader } from "./loader.js";
import { createLogger, type Logger } from "./logger.js";
import { RuleRegistry } from "./rule-registry.js";
import { installSafetyNet, type SafetyNet } from "./safety-net.js";
import { createScheduling } from "./scheduling.js";
import { coreSdkRuntime, installSdkRuntime } from "./sdk-runtime.js";
import { Storage } from "./storage.js";
import { realClock, type Clock } from "./timer.js";

export interface EngineOptions<Config> {
  env: Env;
  adapter: BackendAdapter<Config>;
  /** Log destination; default stdout. */
  logDestination?: NodeJS.WritableStream;
  /** Bind the HTTP server to this port instead of HTTP_PORT (tests use 0 for a free one). */
  httpListenPort?: number;
  /** Interface for the HTTP server; default all. */
  httpHost?: string;
  clock?: Clock;
  /** Aborting gives up connecting during startup. */
  signal?: AbortSignal;
  /** npm executable and environment for installing rule dependencies (tests). */
  npm?: { command?: string; env?: NodeJS.ProcessEnv };
}

export interface Engine {
  readonly config: LoadedConfig<unknown>;
  readonly log: Logger;
  readonly registry: RuleRegistry;
  /** The bound HTTP port, or undefined when HTTP_PORT=0. */
  readonly httpPort: number | undefined;
  /** Connected to the backend and the initial load completed. */
  isReady(): boolean;
  /**
   * Graceful shutdown: stops triggers, runs teardowns, disconnects and writes pending data.
   * Gives up after `timeoutMs` (default SHUTDOWN_TIMEOUT_MS), still writing pending data, and
   * reports the rules that blocked it.
   */
  stop(options?: { timeoutMs?: number }): Promise<ShutdownResult>;
}

export interface ShutdownResult {
  /** Every step finished within the time limit. */
  clean: boolean;
  /** Rules whose unload had not finished when the time limit hit. */
  blockedBy: string[];
}

/** Hard limit for a graceful shutdown (container-image: Graceful shutdown). */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The engine's version from its package.json. */
export function engineVersion(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 4; i++) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "home-engine") return pkg.version ?? "0.0.0";
    }
    dir = join(dir, "..");
  }
  return "0.0.0";
}

/** String values of secret-looking keys, so the logger can scrub them from every line. */
function secretsOf(config: unknown): string[] {
  if (typeof config !== "object" || config === null) return [];
  return Object.entries(config).flatMap(([key, value]) =>
    typeof value === "string" && /token|password|secret/i.test(key) ? [value] : [],
  );
}

export async function startEngine<Config>(options: EngineOptions<Config>): Promise<Engine> {
  const { adapter } = options;
  const config = loadConfig(options.env, adapter.readConfig);
  const { core } = config;
  const log = createLogger({
    level: core.logLevel,
    format: core.logFormat,
    secrets: secretsOf(config.backend),
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  });
  const version = engineVersion();
  log.info({ version, backend: adapter.id }, `home-engine ${version} starting`);
  logEffectiveConfig(log, config);
  const clock = options.clock ?? realClock;

  const cleanups: Array<() => void | Promise<void>> = [];
  const safetyNet: SafetyNet = installSafetyNet(log);
  cleanups.push(() => safetyNet.uninstall());

  let initialLoadDone = false;
  let flushData: () => Promise<void> = async () => {};
  let hotReloader: HotReloader | undefined;
  let registry: RuleRegistry | undefined;
  const http = new HttpServer(
    core.httpPort,
    {
      backend: () => adapter.status(),
      initialLoadDone: () => initialLoadDone,
      rules: () => registry?.listRules() ?? [],
      engine: () => ({
        version,
        backend: adapter.id,
        watchMode: hotReloader?.mode ?? "unavailable",
        dryRun: core.dryRun,
      }),
    },
    log,
    options.httpHost ? { host: options.httpHost } : {},
  );
  const httpPort = await http.start(options.httpListenPort ?? core.httpPort);
  cleanups.push(() => http.stop());

  try {
    await installRuleDependencies({
      rulesDir: core.rulesDir,
      dataDir: core.dataDir,
      log,
      enabled: core.npmInstall,
      ...(options.npm?.command ? { npm: options.npm.command } : {}),
      ...(options.npm?.env ? { env: options.npm.env } : {}),
    });

    const storage = new Storage(join(core.dataDir, "storage"), log);
    await storage.load();
    cleanups.push(() => storage.flush());
    const firedHolds = new FiredHolds(join(core.dataDir, "fired-holds.json"));
    await firedHolds.load();
    cleanups.push(() => firedHolds.flush());
    flushData = () => Promise.all([storage.flush(), firedHolds.flush()]).then(() => undefined);

    log.info(`Connecting to ${adapter.id}`);
    await adapter.start(config.backend, options.signal ?? new AbortController().signal, log);
    cleanups.push(() => adapter.stop());

    const scheduling = createScheduling({
      clock,
      timeZone: () => core.timeZone ?? adapter.site()?.timeZone,
      onSiteChange: (listener) => {
        const sub = adapter.onSiteChange(listener);
        return () => sub.dispose();
      },
      location: () => adapter.site(),
      log,
    });
    const context: AdapterContext = { log, clock, firedHolds, dryRun: core.dryRun };
    installSdkRuntime({
      ...coreSdkRuntime(scheduling, storage, log),
      ...adapter.sdkRuntime(context),
    });
    const sources = { ...scheduling.sources, ...adapter.triggerSources(context) };

    registry = new RuleRegistry({ sources, log }, core.disabledRules);
    const rules = registry;
    cleanups.push(() => rules.unloadAll());
    const loader = new RuleLoader({
      rulesDir: core.rulesDir,
      buildDir: join(core.dataDir, ".build"),
      registry: rules,
      log,
    });
    await loader.loadAll();
    firedHolds.pruneRules(new Set(rules.listRules().map((r) => r.id)));
    logLoadSummary(rules, log);

    hotReloader = new HotReloader({
      rulesDir: core.rulesDir,
      loader,
      log,
      enabled: core.hotReload,
      watchPoll: core.watchPoll,
    });
    const watcher = hotReloader;
    cleanups.push(() => watcher.stop());
    await watcher.start();
    initialLoadDone = true;
    log.info("Engine ready");
  } catch (err) {
    await runCleanups(cleanups, log);
    throw err;
  }

  const rules = registry;
  let stopping: Promise<ShutdownResult> | undefined;
  const shutdown = async (timeoutMs: number): Promise<ShutdownResult> => {
    log.info("Shutting down");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([runCleanups(cleanups, log), timedOut]);
    clearTimeout(timer);
    if (outcome !== "timeout") {
      log.info("Shutdown complete");
      return { clean: true, blockedBy: [] };
    }
    const blockedBy = rules.stillUnloading();
    log.error(
      { blockedBy, timeoutMs },
      `Shutdown did not finish within ${timeoutMs / 1000} s` +
        (blockedBy.length ? `; blocked by ${blockedBy.join(", ")}` : ""),
    );
    // Whatever hangs, stored values must not be lost.
    await flushData().catch((err: unknown) => log.error({ err }, "Writing pending data failed"));
    return { clean: false, blockedBy };
  };
  return {
    config,
    log,
    registry: rules,
    httpPort,
    isReady: () => initialLoadDone && adapter.status().connected,
    stop: (opts = {}) => (stopping ??= shutdown(opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS)),
  };
}

/** Runs cleanups newest first; a failing one is logged and the rest still run. */
async function runCleanups(
  cleanups: Array<() => void | Promise<void>>,
  log: Logger,
): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (err) {
      log.error({ err }, "Shutdown step failed");
    }
  }
}
