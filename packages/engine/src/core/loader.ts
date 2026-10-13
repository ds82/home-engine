// Loading rule files: bundle → evaluate → start (rule-files, rule-lifecycle). One broken file
// never stops the others: syntax errors are reported with file, line and column, evaluation
// errors with their stack, and the file is marked as failed while loading continues.

import { join } from "node:path";
import { DependencyGraph, bundleRuleFile, importBundle } from "./bundler.js";
import { discoverRuleFiles, reportDiscovery } from "./discovery.js";
import type { Logger } from "./logger.js";
import { FileEvaluationError, FileEvaluationTimeoutError, evaluateFile } from "./registration.js";
import type { RuleRegistry } from "./rule-registry.js";
import { RuleScopeImpl } from "./rule-scope.js";

/** A rule file (or a module it imports) does not parse. */
export class RuleSyntaxError extends Error {
  constructor(
    /** File with the error, relative to the rules directory. */
    readonly file: string,
    /** 1-based line and column. */
    readonly line: number,
    readonly column: number,
    readonly detail: string,
  ) {
    super(`Syntax error in ${file}:${line}:${column}: ${detail}`);
    this.name = "RuleSyntaxError";
  }
}

export interface LoaderOptions {
  rulesDir: string;
  /** `<DATA_DIR>/.build`. */
  buildDir: string;
  registry: RuleRegistry;
  log: Logger;
  evaluationTimeoutMs?: number;
}

export class RuleLoader {
  readonly graph = new DependencyGraph();

  constructor(private readonly options: LoaderOptions) {}

  /** Discovers and loads every rule file. Never throws for problems in rule files. */
  async loadAll(): Promise<void> {
    const result = await discoverRuleFiles(this.options.rulesDir);
    reportDiscovery(this.options.log, this.options.rulesDir, result);
    for (const file of result.files) {
      await this.loadFile(file);
    }
  }

  /**
   * (Re)loads one rule file: unloads its previous rules, bundles, evaluates and starts it.
   * Returns false when the file failed; the failure is logged and recorded in the registry.
   */
  async loadFile(file: string): Promise<boolean> {
    const { registry, log } = this.options;
    await registry.unloadFile(file);

    let outfile: string;
    try {
      const bundle = await bundleRuleFile({
        rulesDir: this.options.rulesDir,
        file,
        buildDir: this.options.buildDir,
      });
      outfile = bundle.outfile;
      this.graph.set(file, bundle.inputs);
    } catch (err) {
      const error = toSyntaxError(err) ?? err;
      if (error instanceof RuleSyntaxError) {
        log.error(
          { file: error.file, line: error.line, column: error.column, ruleFile: file },
          error.message,
        );
      } else {
        log.error({ err, file }, `Bundling ${file} failed`);
      }
      registry.fileFailed(file, error);
      return false;
    }

    const fileScope = new RuleScopeImpl(`file:${file}`, log);
    try {
      const rules = await evaluateFile(file, () => importBundle(outfile), {
        fileScope,
        ...(this.options.evaluationTimeoutMs
          ? { timeoutMs: this.options.evaluationTimeoutMs }
          : {}),
      });
      const collision = await registry.loadFile(file, rules, fileScope);
      if (collision) {
        log.error(
          { file, ruleId: collision.ruleId, otherFile: collision.otherFile },
          collision.message,
        );
        return false;
      }
      log.info({ file, rules: rules.length }, `Loaded ${file} (${rules.length} rule(s))`);
      return true;
    } catch (err) {
      if (err instanceof FileEvaluationTimeoutError) {
        log.warn({ file }, err.message);
      } else {
        const cause = err instanceof FileEvaluationError ? err.cause : err;
        log.error({ err: cause ?? err, file }, err instanceof Error ? err.message : String(err));
      }
      registry.fileFailed(file, err);
      return false;
    }
  }

  /** True when `file` was loaded (successfully or not). */
  isLoaded(file: string): boolean {
    return this.options.registry.hasFile(file);
  }

  /** Unloads a rule file that was removed. */
  async unloadFile(file: string): Promise<void> {
    this.graph.delete(file);
    await this.options.registry.unloadFile(file);
    this.options.log.info({ file }, `Unloaded ${file}`);
  }

  /** Path of a rule file on disk. */
  path(file: string): string {
    return join(this.options.rulesDir, file);
  }
}

/** Converts an esbuild build failure into a RuleSyntaxError for its first located error. */
function toSyntaxError(err: unknown): RuleSyntaxError | undefined {
  const errors = (err as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return undefined;
  }
  for (const e of errors as Array<{
    text: string;
    location: { file: string; line: number; column: number } | null;
  }>) {
    if (e.location) {
      return new RuleSyntaxError(e.location.file, e.location.line, e.location.column + 1, e.text);
    }
  }
  return undefined;
}

/** Logs the result of the initial load, e.g. "12 loaded, 1 disabled, 1 failed". */
export function logLoadSummary(registry: RuleRegistry, log: Logger): void {
  const { loaded, disabled, failed } = registry.summary();
  log.info(
    { loaded, disabled, failed },
    `Rules: ${loaded} loaded, ${disabled} disabled, ${failed} failed`,
  );
}
