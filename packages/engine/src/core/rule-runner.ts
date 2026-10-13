// Starting rules (rule-lifecycle: Rule start). A triggered rule arms its triggers and runs
// its body per firing under its concurrency mode. A setup rule runs its setup function once
// (with a timeout); the function registers listeners with `listen()`, which always run in
// parallel. Startup triggers fire once right after the rule has started.

import type {
  ListenerHandle,
  ListenOptions,
  RuleEvent,
  RuleResult,
  StartupTrigger,
  Trigger,
  Triggers,
} from "@home-engine/sdk";
import type { Disposable } from "./adapter.js";
import { ConcurrencyController } from "./concurrency.js";
import type { Logger } from "./logger.js";
import type {
  RuleDefinition,
  SetupRuleDefinition,
  TriggeredRuleDefinition,
} from "./registration.js";
import { RuleScopeImpl } from "./rule-scope.js";
import { currentRun, invoke } from "./run-context.js";
import type { EventPayload, TriggerSources } from "./trigger-source.js";
import { triggerIdentity } from "./trigger-identity.js";

export const SETUP_TIMEOUT_MS = 30_000;

export interface RunnerOptions {
  sources: TriggerSources;
  log: Logger;
  setupTimeoutMs?: number;
  /**
   * Called with a setup rule's scope before its setup function runs, so the rule can be
   * reported as `starting` (with its listeners) until the setup has finished.
   */
  onStarting?: (scope: RuleScopeImpl) => void;
}

export interface StartedRule {
  readonly scope: RuleScopeImpl;
  readonly status: "running" | "failed";
  /** Why the rule failed to start. */
  readonly error: Error | undefined;
  /** Unloads the rule: teardowns, abort, release of all triggers and listeners. */
  stop(): Promise<void>;
}

/** Per-rule state that `listen()` needs; found through the run context's scope. */
interface SetupHost {
  sources: TriggerSources;
  /** True while the setup function has not finished. */
  inSetup: boolean;
  /** Startup listeners registered during setup, fired once setup has finished. */
  startupListeners: Array<() => void>;
  /** Number of listen() calls during setup, for listener identities. */
  listenCount: number;
  /** Explicit IDs of the rule's listeners that are not cancelled; each must be unique. */
  listenerIds: Set<string>;
}

const setupHosts = new WeakMap<RuleScopeImpl, SetupHost>();

export async function startRule(
  definition: RuleDefinition,
  options: RunnerOptions,
): Promise<StartedRule> {
  return definition.kind === "triggered"
    ? startTriggeredRule(definition, options)
    : startSetupRule(definition, options);
}

async function startTriggeredRule(
  definition: TriggeredRuleDefinition,
  options: RunnerOptions,
): Promise<StartedRule> {
  const scope = new RuleScopeImpl(definition.id, options.log);
  const controller = new ConcurrencyController(
    definition.options.mode ?? "parallel",
    definition.options.max,
    scope.log,
  );
  scope.onDispose(() => controller.cancelAll());

  const fire = (trigger: Trigger, payload: EventPayload): void => {
    if (scope.disposed) {
      return;
    }
    traceFiring(scope, trigger, payload);
    controller.submit(() =>
      invoke(scope, "body", (signal) =>
        definition.body({ ...payload, trigger, signal } as RuleEvent),
      ),
    );
  };

  try {
    const startups = arm(scope, options.sources, asList(definition.triggers), fire, {
      position: (i) => `t${i}`,
      restoreHolds: true,
    });
    for (const trigger of startups) {
      fire(trigger, { type: "startup" });
    }
  } catch (err) {
    return failed(scope, err, "Starting the rule failed");
  }
  return started(scope);
}

async function startSetupRule(
  definition: SetupRuleDefinition,
  options: RunnerOptions,
): Promise<StartedRule> {
  const scope = new RuleScopeImpl(definition.id, options.log);
  const host: SetupHost = {
    sources: options.sources,
    inSetup: true,
    startupListeners: [],
    listenCount: 0,
    listenerIds: new Set(),
  };
  setupHosts.set(scope, host);
  options.onStarting?.(scope);

  let result: unknown;
  let threw: unknown;
  const run = invoke(scope, "setup", async () => {
    try {
      result = await definition.fn();
    } catch (err) {
      threw = err;
      throw err;
    }
  });

  const timeoutMs = options.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    run.done.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  host.inSetup = false;

  if (!settled) {
    scope.log.warn(
      { timeoutMs },
      `Setup of rule ${definition.id} did not finish within ${timeoutMs / 1000} s`,
    );
    return failed(scope, new Error(`Setup did not finish within ${timeoutMs / 1000} s`));
  }
  if (threw !== undefined) {
    // invoke() already logged the error with the rule ID.
    return failed(scope, threw);
  }
  if (typeof result === "function") {
    scope.addTeardown(result as () => void | Promise<void>);
  }

  for (const fireStartup of host.startupListeners.splice(0)) {
    fireStartup();
  }
  return started(scope);
}

/**
 * The SDK's `listen()`: registers a listener for the calling setup rule. Throws when called
 * outside a setup rule. Each firing runs the callback in parallel with all others.
 */
export function listen(
  triggers: Triggers,
  callback: (event: RuleEvent) => RuleResult,
  options: ListenOptions = {},
): ListenerHandle {
  const run = currentRun();
  const host = run && setupHosts.get(run.scope);
  if (!run || !host) {
    throw new Error("listen() is only available in setup rules (setup(name, fn)).");
  }
  const scope = run.scope;
  const list = asList(triggers);
  if (!host.inSetup && list.some((t) => t.kind === "startup")) {
    throw new Error("onStartup() can only be used during setup.");
  }

  if (options.id !== undefined && host.listenerIds.has(options.id)) {
    throw new Error(
      `listen(): the id "${options.id}" is already used by another listener of this rule; listener ids must be unique within a rule.`,
    );
  }

  const fire = (trigger: Trigger, payload: EventPayload): void => {
    if (scope.disposed || cancelled) {
      return;
    }
    traceFiring(scope, trigger, payload, "listener");
    invoke(scope, "listener", (signal) => callback({ ...payload, trigger, signal } as RuleEvent));
  };
  let cancelled = false;
  const disarm: Disposable[] = [];
  const armedOfListener: Array<{ nextRun?: () => Date | undefined }> = [];
  // Identity: an explicit id, else the order of listen() calls during setup. Listeners
  // registered after setup never restore holds, so their position does not matter.
  const n = host.inSetup ? host.listenCount++ : -1;
  const base = options.id !== undefined ? `id:${options.id}` : n >= 0 ? `l${n}` : "late";
  const startups = arm(scope, host.sources, list, fire, {
    position: (i) => `${base}.${i}`,
    restoreHolds: host.inSetup,
    collect: disarm,
    armed: armedOfListener,
  });
  if (options.id !== undefined) {
    host.listenerIds.add(options.id);
  }
  for (const trigger of startups) {
    host.startupListeners.push(() => fire(trigger, { type: "startup" }));
  }

  return {
    cancel: () => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      if (options.id !== undefined) {
        host.listenerIds.delete(options.id);
      }
      for (const d of disarm.splice(0)) {
        d.dispose();
      }
    },
    get nextRun() {
      return cancelled ? undefined : earliest(armedOfListener.map((a) => a.nextRun?.()));
    },
  };
}

/** Debug trace of a firing (engine-observability: Engine activity logging). */
function traceFiring(
  scope: RuleScopeImpl,
  trigger: Trigger,
  payload: EventPayload,
  target: "rule" | "listener" = "rule",
): void {
  if (!scope.log.isLevelEnabled("debug")) {
    return;
  }
  const fields = payload as Record<string, unknown>;
  const entityId = typeof fields.entityId === "string" ? fields.entityId : undefined;
  const eventType = typeof fields.eventType === "string" ? fields.eventType : undefined;
  const subject = entityId ?? eventType;
  scope.log.debug(
    { trigger: trigger.kind, event: payload.type, entityId, eventType, firing: target },
    `${trigger.kind} trigger fired${subject ? ` (${subject})` : ""}`,
  );
}

/**
 * Arms every non-startup trigger with its source and registers the disarm with the scope.
 * Returns the startup triggers, which the caller fires itself.
 */
function arm(
  scope: RuleScopeImpl,
  sources: TriggerSources,
  triggers: readonly Trigger[],
  fire: (trigger: Trigger, payload: EventPayload) => void,
  how: {
    position: (index: number) => string;
    restoreHolds: boolean;
    collect?: Disposable[];
    armed?: Array<{ nextRun?: () => Date | undefined }>;
  },
): StartupTrigger[] {
  const startups: StartupTrigger[] = [];
  for (const [index, trigger] of triggers.entries()) {
    if (trigger.kind === "startup") {
      startups.push(trigger);
      continue;
    }
    const source = sources[trigger.kind];
    if (!source) {
      throw new Error(`No trigger source for "${trigger.kind}" triggers`);
    }
    const identity = triggerIdentity(how.position(index), trigger);
    const armed = source(trigger, {
      scope,
      identity,
      restoreHolds: how.restoreHolds,
      fire: (payload) => fire(trigger, payload),
      reportError: (error) => {
        const position = index + 1;
        const description = describeTriggerShort(trigger);
        scope.recordError(error);
        scope.triggerErrors.set(identity, {
          kind: trigger.kind,
          position,
          trigger: description,
          message: error.message,
        });
        scope.log.error(
          { err: error, trigger: trigger.kind, position },
          `Trigger ${position} (${description}) rejected: ${error.message}`,
        );
      },
    });
    const entry = {
      kind: trigger.kind,
      ...(armed.nextRun ? { nextRun: () => armed.nextRun?.() } : {}),
    };
    scope.armedTriggers.add(entry);
    how.armed?.push(entry);
    const disarm = {
      dispose: () => {
        scope.armedTriggers.delete(entry);
        armed.dispose();
      },
    };
    scope.onDispose(() => disarm.dispose());
    how.collect?.push(disarm);
  }
  return startups;
}

/** The earliest of several next-run times. */
export function earliest(times: ReadonlyArray<Date | undefined>): Date | undefined {
  let min: Date | undefined;
  for (const t of times) {
    if (t && (!min || t < min)) {
      min = t;
    }
  }
  return min;
}

function asList(triggers: Triggers): readonly Trigger[] {
  return Array.isArray(triggers) ? triggers : [triggers as Trigger];
}

/** Rule-level lines go through the rule's logger at debug level; files log at info. */
function started(scope: RuleScopeImpl): StartedRule {
  scope.log.debug("Rule started");
  return { scope, status: "running", error: undefined, stop: () => stop(scope) };
}

async function stop(scope: RuleScopeImpl): Promise<void> {
  const first = !scope.disposed;
  await scope.dispose();
  if (first) {
    scope.log.debug("Rule stopped");
  }
}

/** Marks the start as failed and releases everything the rule registered so far. */
async function failed(scope: RuleScopeImpl, err: unknown, message?: string): Promise<StartedRule> {
  if (message) {
    scope.log.error({ err }, message);
  }
  scope.recordError(err);
  await scope.dispose();
  return {
    scope,
    status: "failed",
    error: err instanceof Error ? err : new Error(String(err)),
    stop: () => scope.dispose(),
  };
}

/** A short description of a trigger for the status output, e.g. `ha-trigger numeric_state`. */
export function describeTriggerShort(trigger: Trigger): string {
  switch (trigger.kind) {
    case "ha-trigger": {
      const platform = trigger.config.trigger ?? trigger.config.platform;
      return typeof platform === "string" ? `ha-trigger ${platform}` : "ha-trigger";
    }
    case "state":
      return `state ${trigger.entities.join(", ")}`;
    case "event":
      return `event ${trigger.eventType}`;
    default:
      return trigger.kind;
  }
}
