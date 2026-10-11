// Run as a separate process by safety-net.test.ts: rules misbehave in every way that would
// normally crash Node, and the process must keep running and log attributed errors.

import { createLogger } from "../../logger.js";
import { RuleScopeImpl } from "../../rule-scope.js";
import { invoke } from "../../run-context.js";
import { installSafetyNet, trackWrite } from "../../safety-net.js";

const log = createLogger({ level: "info", format: "json" });
installSafetyNet(log);

const porch = new RuleScopeImpl("lights#porch", log);
const heating = new RuleScopeImpl("climate#heating", log);

invoke(porch, "body", () => {
  // Floating promise that rejects later.
  void (async () => {
    await new Promise((r) => setTimeout(r, 5));
    throw new Error("floating rejection");
  })();
  // Throw from a timer callback.
  setTimeout(() => {
    throw new Error("timer exception");
  }, 10);
});

invoke(heating, "body", () => {
  // Unawaited write that fails.
  void trackWrite(
    Promise.reject(new Error("Service light.turn_on: entity light.missing not found")),
    "light.turn_on → light.missing",
  );
  // Awaited and handled write: must not be logged.
  void (async () => {
    try {
      await trackWrite(Promise.reject(new Error("handled")), "switch.turn_off → switch.x");
    } catch {
      // handled by the rule
    }
  })();
});

setTimeout(() => {
  log.info({ porchError: porch.lastError?.message }, "still running");
}, 50);
