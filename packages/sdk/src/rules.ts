// Rule registration and listeners: the signatures rule authors program against. The engine
// replaces this module with its own runtime when it bundles a rule file.

import type { EventFor } from "./events.js";
import { notInEngine } from "./stub.js";
import type { Triggers } from "./triggers.js";

/**
 * How a triggered rule handles a firing while a previous run is still in progress: `parallel`
 * starts another run, `single` drops the firing, `queued` runs it after the previous ones, and
 * `restart` aborts the run in progress and starts a new one.
 * @category Rules
 */
export type ConcurrencyMode = "parallel" | "single" | "queued" | "restart";

/**
 * Options shared by triggered rules and setup rules.
 * @inline
 */
interface CommonRuleOptions {
  /** Free text shown with the rule in the rule status (`GET /rules`). */
  description?: string;
  /** Registered but never started when false. Default true. */
  enabled?: boolean;
  /** Explicit rule ID replacing `<path>#<name>`; globally unique, without `#`. */
  id?: string;
}

/**
 * Options of {@link rule}.
 * @category Rules
 */
export interface RuleOptions extends CommonRuleOptions {
  /** How overlapping runs of the body are handled. Default `parallel`. */
  mode?: ConcurrencyMode;
  /** For `queued` and `parallel`: maximum runs in progress or waiting (queued default 10). */
  max?: number;
}

/**
 * Options of {@link setup}. Setup rules have no concurrency mode: their listeners always run in parallel.
 * @category Rules
 */
export type SetupOptions = CommonRuleOptions;

/**
 * What a rule body may return: nothing, or a promise of anything (e.g.
 * `() => call("light.turn_on")`). The value is ignored; only a rejection counts as a failed run.
 * @category Rules
 */
export type RuleResult = unknown;

/**
 * Called when a setup rule is unloaded.
 * @category Rules
 */
export type Teardown = () => void | Promise<void>;

/**
 * The function of a setup rule. It runs once each time the rule starts, registers listeners
 * with {@link listen} and may return a {@link Teardown}, also from an async function.
 * @category Rules
 */
// `void` is deliberate: plain `() => {}` and `async () => {}` must be valid setup functions.
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type SetupFunction = () => void | Teardown | Promise<void | Teardown>;

/**
 * A cancellable registration, such as a listener.
 * @category Rules
 */
export interface Handle {
  /** Stops it before the rule is unloaded. Calling it twice is harmless. */
  cancel(): void;
}

/**
 * A cancellable timer or schedule that knows when it fires next.
 * @category Scheduling
 */
export interface TimerHandle extends Handle {
  /** Next time it fires, or undefined when it will not fire again. */
  readonly nextRun: Date | undefined;
}

/**
 * A listener registration; for time triggers it also knows when it fires next.
 * @category Rules
 */
export interface ListenerHandle extends Handle {
  /** Next run of the listener's time triggers, or undefined. */
  readonly nextRun: Date | undefined;
}

/**
 * Options of {@link listen}.
 * @category Rules
 */
export interface ListenOptions {
  /** Stable identity for hold restoration when listeners are registered conditionally. */
  id?: string;
}

/**
 * Registers a triggered rule: `body` runs whenever any of `triggers` fires.
 * Call it while the rule file is being loaded.
 * @category Rules
 */
export function rule<const T extends Triggers>(
  name: string,
  triggers: T,
  body: (event: EventFor<T>) => RuleResult,
  options?: RuleOptions,
): void;
export function rule(): void {
  notInEngine("rule");
}

/**
 * Registers a setup rule: `fn` runs once each time the rule starts and registers
 * listeners with `listen()`. It may return a teardown function.
 * @category Rules
 */
export function setup(name: string, fn: SetupFunction, options?: SetupOptions): void;
export function setup(): void {
  notInEngine("setup");
}

/**
 * Registers a listener for the calling setup rule. Only available in setup rules.
 * @category Rules
 */
export function listen<const T extends Triggers>(
  triggers: T,
  callback: (event: EventFor<T>) => RuleResult,
  options?: ListenOptions,
): ListenerHandle;
export function listen(): ListenerHandle {
  return notInEngine("listen");
}
