// Run attribution (design D4 "Run attribution with AsyncLocalStorage"). Every rule body,
// setup function and callback runs inside `invoke()`, which stores the rule's scope and the
// run's signal in an AsyncLocalStorage. The context follows `await`, promises, timers and
// emitters, so free SDK functions find the calling rule without a context parameter.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RuleScopeImpl } from "./rule-scope.js";

export interface RunContext {
  scope: RuleScopeImpl;
  /** Aborted when this run is cancelled (restart mode) or the rule is unloaded. */
  signal: AbortSignal;
}

const storage = new AsyncLocalStorage<RunContext>();

/**
 * Runs `fn` as code of `scope` outside a run (e.g. a teardown while unloading), so SDK
 * functions such as `log` attribute it to the rule.
 */
export function runInScope<T>(scope: RuleScopeImpl, fn: () => T): T {
  return storage.run({ scope, signal: scope.signal }, fn);
}

/** The context of the calling rule code, if any. */
export function currentRun(): RunContext | undefined {
  return storage.getStore();
}

/** The calling rule's scope, or a clear error for SDK functions that need one. */
export function requireRun(fn: string): RunContext {
  const run = storage.getStore();
  if (!run) {
    throw new Error(
      `${fn}() must be called from rule code (a rule body, setup function or listener); ` +
        "the call lost its rule context, e.g. inside a third-party library callback.",
    );
  }
  return run;
}

export type RunKind = "body" | "setup" | "listener" | "callback";

export interface Run {
  /** The run's own signal (child of the rule's signal). */
  readonly signal: AbortSignal;
  /** Settles when the run finished; never rejects (errors are logged and recorded). */
  readonly done: Promise<void>;
  /** Cancels the run: its signal aborts, pending sleeps reject with an AbortError. */
  abort(): void;
}

/**
 * Runs rule code with attribution and isolation: sync throws and rejections are caught,
 * logged with the rule ID and stack, and recorded on the scope. AbortErrors caused by the
 * engine's own aborts (restart, unload) are swallowed. Never throws.
 */
export function invoke(
  scope: RuleScopeImpl,
  kind: RunKind,
  fn: (signal: AbortSignal) => unknown,
): Run {
  const runController = new AbortController();
  const signal = AbortSignal.any([scope.signal, runController.signal]);
  if (kind === "body" || kind === "listener") {
    scope.lastRunAt = new Date();
  }

  const done = storage
    .run({ scope, signal }, async () => {
      await fn(signal);
    })
    .catch((err: unknown) => {
      if (signal.aborted && isAbortError(err)) {
        scope.log.debug({ kind }, "Run aborted");
        return;
      }
      scope.recordError(err);
      scope.log.error({ err, kind }, `Rule ${kind === "setup" ? "setup" : kind} failed`);
    });

  return {
    signal,
    done,
    abort: () => runController.abort(abortError("Run was cancelled")),
  };
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}
