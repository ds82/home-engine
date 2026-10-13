// Hot reload (rule-lifecycle: Hot reload of changed files; design D3, D14). Watches the rules
// directory, collects file events for a short quiet period (so an editor's burst of writes
// causes one reload), then works out which rule files are affected: changed rule files plus
// every rule file whose bundle includes a changed helper (from the bundles' metafiles).
// Deleted and newly conflicting files are unloaded first, then the affected valid files are
// loaded (again), so a file moved to another path keeps its explicit rule IDs.

import { EventEmitter } from "node:events";
import { relative, resolve, sep } from "node:path";
import { watch, type ChokidarOptions } from "chokidar";
import type { WatchPollMode } from "./config.js";
import { discoverRuleFiles, reportDiscovery } from "./discovery.js";
import type { RuleLoader } from "./loader.js";
import type { Logger } from "./logger.js";
import { fileIdBase } from "./registration.js";

export const DEBOUNCE_MS = 200;
/** Polling interval; changes are detected within about this time plus the debounce. */
export const POLL_INTERVAL_MS = 1_000;

/** The parts of a chokidar watcher the reloader uses. */
export interface Watcher extends EventEmitter {
  close(): Promise<void>;
}

export type WatchFactory = (path: string, options: ChokidarOptions) => Watcher;

/** How the rules directory is watched right now. */
export type WatchMode = "native" | "polling" | "unavailable" | "disabled";

export interface HotReloadOptions {
  rulesDir: string;
  loader: RuleLoader;
  log: Logger;
  /** HOT_RELOAD; when false nothing is watched and rules change only on restart. */
  enabled?: boolean;
  /** WATCH_POLL: `auto` (native, fall back to polling), `true` (always poll), `false` (never). */
  watchPoll?: WatchPollMode;
  /** Quiet period after the last file event before reloading. */
  debounceMs?: number;
  /** Creates watchers; injectable for tests. */
  watchFactory?: WatchFactory;
}

export interface ReloadSummary {
  reloaded: string[];
  unloaded: string[];
}

export class HotReloader {
  private watcher: Watcher | undefined;
  private currentMode: WatchMode = "unavailable";
  /** Set while a failed native watcher is being replaced by a polling one. */
  private replacing: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly changed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Serialises flushes: rule files are evaluated one at a time. */
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(summary: ReloadSummary) => void>();
  private readonly rulesDir: string;

  constructor(private readonly options: HotReloadOptions) {
    this.rulesDir = resolve(options.rulesDir);
  }

  /** The active watch mode, for the startup log and the status endpoint. */
  get mode(): WatchMode {
    return this.currentMode;
  }

  /** Starts watching; resolves once a watcher is ready (or hot reload is unavailable). */
  async start(): Promise<void> {
    if (this.options.enabled === false) {
      this.currentMode = "disabled";
      this.options.log.info(
        "Hot reload is disabled (HOT_RELOAD=false); rule changes apply on restart",
      );
      return;
    }
    const poll = this.options.watchPoll ?? "auto";
    await this.startWatcher(poll === "true" ? "polling" : "native");
    this.options.log.info(
      { watchMode: this.currentMode, watchPoll: poll },
      this.currentMode === "unavailable"
        ? "Hot reload is unavailable"
        : `Watching ${this.rulesDir} for changes (${this.currentMode})`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = undefined;
    if (this.currentMode !== "disabled") {
      this.currentMode = "unavailable";
    }
    await this.queue;
  }

  private async startWatcher(mode: "native" | "polling"): Promise<void> {
    const factory = this.options.watchFactory ?? ((path, opts) => watch(path, opts));
    const watcher = factory(this.rulesDir, {
      ignoreInitial: true,
      ignored: (path: string) => path.split(sep).includes("node_modules"),
      usePolling: mode === "polling",
      interval: POLL_INTERVAL_MS,
      binaryInterval: POLL_INTERVAL_MS,
    });
    this.watcher = watcher;
    this.currentMode = mode;
    for (const event of ["add", "change", "unlink"] as const) {
      watcher.on(event, (path: string) => this.onFileEvent(path));
    }

    let failedEarly: unknown;
    const ready = new Promise<void>((resolveReady) => {
      watcher.once("ready", () => resolveReady());
      watcher.on("error", (err: unknown) => {
        failedEarly ??= err;
        resolveReady();
        void this.onWatchError(watcher, mode, err);
      });
    });
    await ready;
    // A setup failure already switched watchers; wait for the replacement to be ready.
    if (failedEarly !== undefined) {
      await this.replacing;
    }
  }

  /** Native watching failed: fall back to polling (auto), or give up (WATCH_POLL=false). */
  private async onWatchError(watcher: Watcher, mode: WatchMode, err: unknown): Promise<void> {
    const { log } = this.options;
    if (watcher !== this.watcher || this.stopped) {
      return;
    }
    const reason = (err as NodeJS.ErrnoException).code ?? String(err);
    const poll = this.options.watchPoll ?? "auto";

    if (mode === "native" && poll === "auto") {
      log.warn(
        { err, reason },
        `Native file watching failed (${reason}); falling back to polling every ${POLL_INTERVAL_MS / 1000} s`,
      );
      this.watcher = undefined;
      this.replacing = watcher.close().then(() => this.startWatcher("polling"));
      await this.replacing;
      return;
    }

    if (mode === "native" && poll === "false") {
      log.error(
        { err, reason },
        `Native file watching failed (${reason}) and WATCH_POLL=false; hot reload is unavailable, loaded rules keep running`,
      );
      this.watcher = undefined;
      this.currentMode = "unavailable";
      await watcher.close();
      return;
    }

    log.error({ err, reason }, "Watching the rules directory failed");
  }

  /** Called after every reload with what was reloaded or unloaded. */
  onReload(listener: (summary: ReloadSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onFileEvent(path: string): void {
    this.changed.add(resolve(path));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.changed];
      this.changed.clear();
      this.queue = this.queue.then(() => this.flush(paths));
    }, this.options.debounceMs ?? DEBOUNCE_MS);
  }

  private async flush(paths: string[]): Promise<void> {
    const { loader, log } = this.options;
    try {
      const rel = (p: string): string => relative(this.rulesDir, p).split(sep).join("/");
      if (paths.some((p) => /^package(-lock)?\.json$/.test(rel(p)))) {
        log.warn("Rule dependencies changed; restart the engine to install them");
      }

      // Rule files directly changed, plus rule files whose bundles include a changed file.
      const affected = new Set<string>();
      for (const path of paths) {
        affected.add(rel(path));
        for (const dependent of loader.graph.dependents(path)) {
          affected.add(dependent);
        }
      }

      const discovery = await discoverRuleFiles(this.rulesDir);
      const valid = new Set(discovery.files);
      // A file whose .ts/.js twin appeared or went away is affected too: the whole conflict
      // group is unloaded, and a file that was blocked by a removed twin loads again.
      const bases = new Set([...affected].map(fileIdBase));
      const conflicting = discovery.conflicts.filter((c) => c.files.some((f) => affected.has(f)));
      for (const conflict of conflicting) {
        for (const file of conflict.files) {
          affected.add(file);
        }
      }
      for (const file of valid) {
        if (bases.has(fileIdBase(file)) && !loader.isLoaded(file)) {
          affected.add(file);
        }
      }
      if (conflicting.length > 0) {
        reportDiscovery(log, this.rulesDir, { files: [], conflicts: conflicting });
      }

      // Unloads first, so a moved file's rule IDs are free before the new path loads.
      const summary: ReloadSummary = { reloaded: [], unloaded: [] };
      const sorted = [...affected].sort();
      for (const file of sorted) {
        if (!valid.has(file) && loader.isLoaded(file)) {
          await loader.unloadFile(file);
          summary.unloaded.push(file);
        }
      }
      for (const file of sorted) {
        if (valid.has(file)) {
          await loader.loadFile(file);
          summary.reloaded.push(file);
        }
      }
      if (summary.reloaded.length + summary.unloaded.length > 0) {
        for (const listener of [...this.listeners]) {
          listener(summary);
        }
      }
    } catch (err) {
      log.error({ err }, "Reloading rule files failed");
    }
  }
}
