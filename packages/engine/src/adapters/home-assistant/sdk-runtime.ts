// The Home Assistant adapter's part of the SDK runtime; merged into the core's at startup.

import type { SdkRuntime } from "../../core/sdk-runtime.js";
import { onChange, onEvent, onTrigger } from "./trigger-constructors.js";

export function homeAssistantSdkRuntime(): SdkRuntime {
  return { onChange, onEvent, onTrigger };
}
