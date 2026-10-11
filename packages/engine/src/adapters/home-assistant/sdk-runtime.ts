// The Home Assistant adapter's part of the SDK runtime; merged into the core's at startup.

import type { SdkRuntime } from "../../core/sdk-runtime.js";
import type { HaClient } from "./client.js";
import type { HoldClock } from "./state-triggers.js";
import { onChange, onEvent, onTrigger } from "./trigger-constructors.js";
import { createStateHelpers } from "./state-helpers.js";
import { createWaitFor } from "./wait-for.js";
import { createWrites, type WritesOptions } from "./writes.js";
import type { Logger } from "../../core/logger.js";

export function homeAssistantSdkRuntime(
  client?: HaClient,
  clock?: HoldClock,
  log?: Logger,
  options: WritesOptions = {},
): SdkRuntime {
  return {
    onChange,
    onEvent,
    onTrigger,
    ...(client
      ? {
          waitFor: createWaitFor(client, clock),
          ...createStateHelpers(client.states),
          ...(log ? createWrites(client, log, options) : {}),
        }
      : {}),
  };
}
