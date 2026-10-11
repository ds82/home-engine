// The set of loaded rule files and their rules (rule-lifecycle: Rule status tracking,
// Disable rules via configuration). Starts a file's rules after successful evaluation,
// skips disabled ones, unloads them again, and reports status per rule and per file.

import type { RuleDefinition } from "./registration.js";
import { startRule, type RunnerOptions, type StartedRule } from "./rule-runner.js";

export type RuleStatus = "running" | "disabled" | "failed";

export interface RuleInfo {
  id: string;
  name: string;
  file: string;
  kind: RuleDefinition["kind"];
  description: string | undefined;
  status: RuleStatus;
  /** Why the rule is disabled. */
  disabledBy: "option" | "config" | undefined;
  loadedAt: Date;
  lastRunAt: Date | undefined;
  /** Last error of a failed start, a body or a callback. */
  lastError: string | undefined;
}

export interface FileInfo {
  file: string;
  status: "loaded" | "failed";
  loadedAt: Date;
  error: string | undefined;
}

interface RuleEntry {
  definition: RuleDefinition;
  loadedAt: Date;
  disabledBy: "option" | "config" | undefined;
  started: StartedRule | undefined;
}

/** True when `ruleId` matches a DISABLED_RULES glob (`*` matches anything, `?` one char). */
export function matchesRulePattern(pattern: string, ruleId: string): boolean {
  const source = pattern
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`).test(ruleId);
}

export class RuleRegistry {
  private readonly files = new Map<string, FileInfo>();
  private readonly rules = new Map<string, RuleEntry[]>();

  constructor(
    private readonly runner: RunnerOptions,
    private readonly disabledPatterns: readonly string[] = [],
  ) {}

  /**
   * Starts the rules of a successfully evaluated file (replacing a previous version must be
   * done with `unloadFile` first). If one of its explicit IDs is already used by another
   * file, the whole file fails and nothing of it starts.
   */
  async loadFile(file: string, definitions: readonly RuleDefinition[]): Promise<void> {
    const loadedAt = new Date();
    const collision = this.findIdCollision(file, definitions);
    if (collision) {
      this.fileFailed(file, collision);
      return;
    }

    const entries: RuleEntry[] = [];
    this.rules.set(file, entries);
    this.files.set(file, { file, status: "loaded", loadedAt, error: undefined });

    for (const definition of definitions) {
      const disabledBy =
        definition.options.enabled === false
          ? "option"
          : this.disabledPatterns.some((p) => matchesRulePattern(p, definition.id))
            ? "config"
            : undefined;
      const entry: RuleEntry = { definition, loadedAt, disabledBy, started: undefined };
      entries.push(entry);
      if (!disabledBy) entry.started = await startRule(definition, this.runner);
    }
  }

  /** Records a file that failed to evaluate; its previous rules must already be unloaded. */
  fileFailed(file: string, error: unknown): void {
    this.files.set(file, {
      file,
      status: "failed",
      loadedAt: new Date(),
      error: error instanceof Error ? error.message : String(error),
    });
    this.rules.delete(file);
  }

  /** Stops every rule of `file` and forgets the file. */
  async unloadFile(file: string): Promise<void> {
    const entries = this.rules.get(file) ?? [];
    this.rules.delete(file);
    this.files.delete(file);
    await Promise.all(entries.map((e) => e.started?.stop()));
  }

  /** Stops everything (engine shutdown). */
  async unloadAll(): Promise<void> {
    await Promise.all([...this.files.keys()].map((file) => this.unloadFile(file)));
  }

  listRules(): RuleInfo[] {
    return [...this.rules.values()].flat().map((entry) => this.info(entry));
  }

  listFiles(): FileInfo[] {
    return [...this.files.values()];
  }

  rule(id: string): RuleInfo | undefined {
    for (const entries of this.rules.values()) {
      const entry = entries.find((e) => e.definition.id === id);
      if (entry) return this.info(entry);
    }
    return undefined;
  }

  private info(entry: RuleEntry): RuleInfo {
    const { definition, started } = entry;
    const scope = started?.scope;
    const status: RuleStatus = entry.disabledBy
      ? "disabled"
      : started?.status === "failed"
        ? "failed"
        : "running";
    return {
      id: definition.id,
      name: definition.name,
      file: definition.file,
      kind: definition.kind,
      description: definition.options.description,
      status,
      disabledBy: entry.disabledBy,
      loadedAt: entry.loadedAt,
      lastRunAt: scope?.lastRunAt,
      lastError: (started?.error ?? scope?.lastError)?.message,
    };
  }

  private findIdCollision(file: string, definitions: readonly RuleDefinition[]): Error | undefined {
    for (const definition of definitions) {
      for (const [otherFile, entries] of this.rules) {
        if (otherFile === file) continue;
        if (entries.some((e) => e.definition.id === definition.id)) {
          return new Error(
            `Rule ID "${definition.id}" in ${file} is already used by a rule in ${otherFile}`,
          );
        }
      }
    }
    return undefined;
  }
}
