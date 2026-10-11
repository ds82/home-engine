// Scoped native timers (rule-lifecycle: Native timers in rule code are scoped; design D4).
// The bundler injects these functions in place of the free identifiers `setTimeout`,
// `setInterval`, `clearTimeout` and `clearInterval` in rule files and their local modules.
// They behave like the globals, but each timer is registered with the scope it was created
// in (the running rule, or the file during evaluation) and cleared when that is unloaded.
// npm packages keep the real globals.

import { currentFileScope } from "./registration.js";
import type { RuleScope } from "./rule-scope.js";
import { currentRun } from "./run-context.js";

export const TIMERS_KEY = Symbol.for("home-engine.timers");

const real = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
};

type Handle = ReturnType<typeof setTimeout>;

/** Unregisters a live timer from its scope. */
const untrack = new WeakMap<object, () => void>();

function ownerScope(): RuleScope | undefined {
  return currentRun()?.scope ?? currentFileScope();
}

function track(handle: Handle, clear: (h: Handle) => void): void {
  const scope = ownerScope();
  if (!scope) return;
  const uncount = (scope as { trackTimer?: () => () => void }).trackTimer?.();
  const remove = scope.onDispose(() => {
    uncount?.();
    clear(handle);
  });
  untrack.set(handle, () => {
    uncount?.();
    remove();
  });
}

function release(handle: unknown): void {
  if (handle !== null && typeof handle === "object") {
    untrack.get(handle)?.();
    untrack.delete(handle);
  }
}

export const scopedTimers = {
  setTimeout<A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): Handle {
    const handle: Handle = real.setTimeout(
      (...a: A) => {
        release(handle);
        fn(...a);
      },
      ms,
      ...args,
    );
    track(handle, real.clearTimeout);
    return handle;
  },
  setInterval<A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): Handle {
    const handle = real.setInterval(fn, ms, ...args);
    track(handle, real.clearInterval);
    return handle;
  },
  clearTimeout(handle: Handle | string | number | undefined): void {
    release(handle);
    real.clearTimeout(handle);
  },
  clearInterval(handle: Handle | string | number | undefined): void {
    release(handle);
    real.clearInterval(handle);
  },
};

(globalThis as Record<symbol, unknown>)[TIMERS_KEY] = scopedTimers;
