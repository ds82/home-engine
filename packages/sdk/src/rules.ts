// Rule registration and listeners: the signatures rule authors program against. The engine
// replaces this module with its own runtime when it bundles a rule file.

import type { EventFor } from "./events.js";
import { notInEngine } from "./stub.js";
import type { Triggers } from "./triggers.js";

export type ConcurrencyMode = "parallel" | "single" | "queued" | "restart";

interface CommonRuleOptions {
  description?: string;
  /** Registered but never started when false. Default true. */
  enabled?: boolean;
  /** Explicit rule ID replacing `<path>#<name>`; globally unique, without `#`. */
  id?: string;
}

export interface RuleOptions extends CommonRuleOptions {
  /** How overlapping runs of the body are handled. Default `parallel`. */
  mode?: ConcurrencyMode;
  /** For `queued` and `parallel`: maximum runs in progress or waiting (queued default 10). */
  max?: number;
}

/** Setup rules have no concurrency mode: their listeners always run in parallel. */
export type SetupOptions = CommonRuleOptions;

/** What a rule body may return. */
export type RuleResult = void | Promise<void>;

/** Called when a setup rule is unloaded. */
export type Teardown = () => void | Promise<void>;

// `void` is deliberate: plain `() => {}` and `async () => {}` must be valid setup functions.
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type SetupFunction = () => void | Teardown | Promise<void | Teardown>;

/** A cancellable registration, such as a listener. */
export interface Handle {
  /** Stops it before the rule is unloaded. Calling it twice is harmless. */
  cancel(): void;
}

/** A cancellable timer or schedule that knows when it fires next. */
export interface TimerHandle extends Handle {
  /** Next time it fires, or undefined when it will not fire again. */
  readonly nextRun: Date | undefined;
}

/** A listener registration; for time triggers it also knows when it fires next. */
export interface ListenerHandle extends Handle {
  /** Next run of the listener's time triggers, or undefined. */
  readonly nextRun: Date | undefined;
}

export interface ListenOptions {
  /** Stable identity for hold restoration when listeners are registered conditionally. */
  id?: string;
}

/**
 * Registers a triggered rule: `body` runs whenever any of `triggers` fires.
 * Call it while the rule file is being loaded.
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
 */
export function setup(name: string, fn: SetupFunction, options?: SetupOptions): void;
export function setup(): void {
  notInEngine("setup");
}

/** Registers a listener for the calling setup rule. Only available in setup rules. */
export function listen<const T extends Triggers>(
  triggers: T,
  callback: (event: EventFor<T>) => RuleResult,
  options?: ListenOptions,
): ListenerHandle;
export function listen(): ListenerHandle {
  return notInEngine("listen");
}
