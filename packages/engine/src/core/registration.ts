// Rule registration while a rule file is evaluated (rule-files spec; design D4
// "Registration context"). Each file is evaluated inside an AsyncLocalStorage holding its
// registry, so the registry follows the file's own code (top-level await, timers it starts)
// and nothing else. `rule()` and `setup()` record into it, and throw outside any file or
// once the file's evaluation has ended: a timed-out file that keeps running cannot add rules,
// to itself or to the file loaded after it. Only after evaluation, including top-level
// await, has settled successfully are the file's rules handed out as one unit; a failing
// file registers nothing.

import type {
  RuleOptions,
  RuleResult,
  RuleEvent,
  SetupFunction,
  SetupOptions,
  Triggers,
} from "@home-engine/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuleScope } from "./rule-scope.js";

export interface TriggeredRuleDefinition {
  kind: "triggered";
  id: string;
  name: string;
  file: string;
  triggers: Triggers;
  body: (event: RuleEvent) => RuleResult;
  options: RuleOptions;
}

export interface SetupRuleDefinition {
  kind: "setup";
  id: string;
  name: string;
  file: string;
  fn: SetupFunction;
  options: SetupOptions;
}

export type RuleDefinition = TriggeredRuleDefinition | SetupRuleDefinition;

/** A rule definition error raised by `rule()`/`setup()` at the call site. */
export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationError";
  }
}

/** A rule file could not be evaluated; none of its rules were registered. */
export class FileEvaluationError extends Error {
  constructor(
    readonly file: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileEvaluationError";
  }
}

/** A rule file's evaluation did not settle in time; the file may still be running. */
export class FileEvaluationTimeoutError extends FileEvaluationError {
  constructor(file: string, timeoutMs: number) {
    super(file, `Evaluating ${file} did not finish within ${timeoutMs / 1000} s`);
    this.name = "FileEvaluationTimeoutError";
  }
}

export const EVALUATION_TIMEOUT_MS = 30_000;

interface FileRegistry {
  file: string;
  /** Owns resources created at the file's top level (e.g. native timers). */
  scope: RuleScope | undefined;
  rules: RuleDefinition[];
  names: Set<string>;
  /** Set when evaluation ended (settled, failed or timed out); registering then throws. */
  closed: boolean;
}

/** The registry of the file whose code is running, if any. */
const fileStorage = new AsyncLocalStorage<FileRegistry>();

/** The file being evaluated. The loader evaluates one at a time. */
let evaluating: FileRegistry | undefined;

/**
 * The scope of the file whose code is running (for resources created at top level, or
 * later by code the file started). A failed or timed-out file's scope is disposed, so
 * resources registered on it are released at once.
 */
export function currentFileScope(): RuleScope | undefined {
  return fileStorage.getStore()?.scope;
}

/** `lights/hallway.ts` → `lights/hallway` (always with `/` separators). */
export function fileIdBase(file: string): string {
  return file.replaceAll("\\", "/").replace(/\.(ts|mts|js|mjs)$/, "");
}

/**
 * Evaluates one rule file with the registration slot pointing at it. `evaluate` runs the
 * file (e.g. a dynamic import). Resolves with the file's rules, or rejects with
 * FileEvaluationError if evaluation throws, rejects or takes longer than `timeoutMs`.
 */
export async function evaluateFile(
  file: string,
  evaluate: () => Promise<unknown>,
  options: {
    timeoutMs?: number;
    /** Receives resources created at the file's top level; disposed if evaluation fails. */
    fileScope?: RuleScope & { dispose(): Promise<void> };
  } = {},
): Promise<RuleDefinition[]> {
  if (evaluating) {
    throw new Error(
      `Cannot evaluate ${file} while ${evaluating.file} is being evaluated; files load one at a time.`,
    );
  }
  const registry: FileRegistry = {
    file,
    scope: options.fileScope,
    rules: [],
    names: new Set(),
    closed: false,
  };
  evaluating = registry;
  const timeoutMs = options.timeoutMs ?? EVALUATION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fileStorage.run(registry, evaluate),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new FileEvaluationTimeoutError(file, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    registry.closed = true;
    await options.fileScope?.dispose();
    if (err instanceof FileEvaluationError) {
      throw err;
    }
    throw new FileEvaluationError(file, `Loading ${file} failed: ${errorMessage(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    registry.closed = true;
    if (evaluating === registry) {
      evaluating = undefined;
    }
  }
  return registry.rules;
}

/** Implementation of the SDK's `rule()`. */
export function registerTriggeredRule(
  name: string,
  triggers: Triggers,
  body: (event: RuleEvent) => RuleResult,
  options: RuleOptions = {},
): void {
  const registry = activeRegistry("rule");
  if (typeof body !== "function") {
    throw new RegistrationError(`rule("${name}"): the body must be a function.`);
  }
  if (triggers === undefined || (Array.isArray(triggers) && triggers.length === 0)) {
    throw new RegistrationError(`rule("${name}"): at least one trigger is required.`);
  }
  add(registry, {
    kind: "triggered",
    id: ruleId(registry.file, name, options.id),
    name,
    file: registry.file,
    triggers,
    body,
    options,
  });
}

/** Implementation of the SDK's `setup()`. */
export function registerSetupRule(
  name: string,
  fn: SetupFunction,
  options: SetupOptions = {},
): void {
  const registry = activeRegistry("setup");
  if ("mode" in options) {
    throw new RegistrationError(
      `setup("${name}"): concurrency modes apply only to triggered rules; setup listeners always run in parallel.`,
    );
  }
  if (typeof fn !== "function") {
    throw new RegistrationError(`setup("${name}"): the setup function must be a function.`);
  }
  add(registry, {
    kind: "setup",
    id: ruleId(registry.file, name, options.id),
    name,
    file: registry.file,
    fn,
    options,
  });
}

function activeRegistry(fn: string): FileRegistry {
  const registry = fileStorage.getStore();
  if (!registry) {
    throw new RegistrationError(
      `${fn}() can only be called while its rule file is loaded (at top level or in code that runs during loading), not later from a callback.`,
    );
  }
  if (registry.closed) {
    throw new RegistrationError(
      `${fn}() was called by ${registry.file} after its loading ended; rules can only be registered while the file is loaded.`,
    );
  }
  return registry;
}

function add(registry: FileRegistry, definition: RuleDefinition): void {
  const { name } = definition;
  if (typeof name !== "string" || name.trim() === "") {
    throw new RegistrationError(`Rule names must be non-empty strings (in ${registry.file}).`);
  }
  if (registry.names.has(name)) {
    throw new RegistrationError(
      `Duplicate rule name "${name}" in ${registry.file}; rule names must be unique within a file.`,
    );
  }
  registry.names.add(name);
  registry.rules.push(definition);
}

function ruleId(file: string, name: string, explicit: string | undefined): string {
  if (explicit === undefined) {
    return `${fileIdBase(file)}#${name}`;
  }
  if (typeof explicit !== "string" || explicit.trim() === "") {
    throw new RegistrationError(`Rule "${name}" in ${file}: id must be a non-empty string.`);
  }
  if (explicit.includes("#")) {
    throw new RegistrationError(
      `Rule "${name}" in ${file}: id "${explicit}" must not contain "#".`,
    );
  }
  return explicit;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
