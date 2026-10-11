// What a started rule owns: its abort signal and the resources to release on unload.
// The implementation (with concurrency modes and error attribution) comes with the rule runtime.

export interface RuleScope {
  readonly ruleId: string;
  /** Aborted when the rule is unloaded. */
  readonly signal: AbortSignal;
  /** Registers a function that runs when the rule is unloaded (in reverse order of registration). */
  onDispose(dispose: () => void | Promise<void>): void;
}
