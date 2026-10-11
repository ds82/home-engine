// Dry-run mode (ha-actions: Dry-run mode; design D13). The core owns the flag and the log
// line; each adapter's write layer decides what counts as an outgoing write and calls
// `logDryRun` instead of sending it.

import type { Logger } from "./logger.js";

/**
 * Logs a write that dry-run mode suppressed, as `[dry-run] <rule-id> <what>` at info level
 * with the full payload.
 */
export function logDryRun(
  log: Logger,
  ruleId: string,
  what: string,
  payload: Record<string, unknown>,
): void {
  log.info({ dryRun: true, ...payload }, `[dry-run] ${ruleId} ${what}`);
}
