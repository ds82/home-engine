// Hot reload (rule-lifecycle: Hot reload of changed files; design D3, D14). Watches the rules
// directory, collects file events for a short quiet period (so an editor's burst of writes
// causes one reload), then works out which rule files are affected: changed rule files plus
// every rule file whose bundle includes a changed helper (from the bundles' metafiles).
// Affected files are unloaded and loaded again; deleted ones are only unloaded.

import { relative, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { discoverRuleFiles, reportDiscovery } from "./discovery.js";
import type { RuleLoader } from "./loader.js";
import type { Logger } from "./logger.js";

export const DEBOUNCE_MS = 200;

export interface HotReloadOptions {
  rulesDir: string;
  loader: RuleLoader;
  log: Logger;
  /** Quiet period after the last file event before reloading. */
  debounceMs?: number;
}

export interface ReloadSummary {
  reloaded: string[];
  unloaded: string[];
}

export class HotReloader {
  private watcher: FSWatcher | undefined;
  private readonly changed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Serialises flushes: rule files are evaluated one at a time. */
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(summary: ReloadSummary) => void>();
  private readonly rulesDir: string;

  constructor(private readonly options: HotReloadOptions) {
    this.rulesDir = resolve(options.rulesDir);
  }

  /** Starts watching; resolves once the watcher is ready. */
  async start(): Promise<void> {
    const watcher = watch(this.rulesDir, {
      ignoreInitial: true,
      ignored: (path) => path.split(sep).includes("node_modules"),
    });
    this.watcher = watcher;
    for (const event of ["add", "change", "unlink"] as const) {
      watcher.on(event, (path: string) => this.onFileEvent(path));
    }
    watcher.on("error", (err: unknown) =>
      this.options.log.error({ err }, "Watching the rules directory failed"),
    );
    await new Promise<void>((ready) => watcher.once("ready", () => ready()));
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = undefined;
    await this.queue;
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
        for (const dependent of loader.graph.dependents(path)) affected.add(dependent);
      }

      const discovery = await discoverRuleFiles(this.rulesDir);
      const valid = new Set(discovery.files);
      const conflicting = discovery.conflicts.filter((c) => c.files.some((f) => affected.has(f)));
      if (conflicting.length > 0)
        reportDiscovery(log, this.rulesDir, { files: [], conflicts: conflicting });

      const summary: ReloadSummary = { reloaded: [], unloaded: [] };
      for (const file of [...affected].sort()) {
        if (valid.has(file)) {
          await loader.loadFile(file);
          summary.reloaded.push(file);
        } else if (loader.isLoaded(file)) {
          await loader.unloadFile(file);
          summary.unloaded.push(file);
        }
      }
      if (summary.reloaded.length + summary.unloaded.length > 0) {
        for (const listener of [...this.listeners]) listener(summary);
      }
    } catch (err) {
      log.error({ err }, "Reloading rule files failed");
    }
  }
}
