// Writes to Home Assistant. They may be awaited; if not, a failure is logged for the rule.

import type { ServiceData, ServiceName, ServiceTarget } from "./entities.js";
import { notInEngine } from "./stub.js";

export interface CallOptions {
  /** Request response data (e.g. weather.get_forecasts) and resolve with it. */
  returnResponse?: boolean;
}

/**
 * Calls a Home Assistant service. Resolves when Home Assistant acknowledged the call (with the
 * response data when `returnResponse` is set); rejects with Home Assistant's error, or at once
 * when not connected.
 */
export function call<S extends ServiceName>(
  service: S,
  data?: ServiceData<S>,
  target?: ServiceTarget,
  options?: CallOptions,
): Promise<unknown>;
export function call(): Promise<unknown> {
  return notInEngine("call");
}
