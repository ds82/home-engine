// Rules for the end-to-end test (scripts/e2e-ha.sh). The script replaces this file to test hot
// reload; the replacement differs only in VERSION.
import { forceOn, log, onChange, onDispose, onStartup, rule, setState } from "@home-engine/sdk";

const VERSION = "v1";

rule("loaded", onStartup(), () => {
  log.info(`E2E rules loaded ${VERSION}`);
  onDispose(() => log.info(`E2E teardown ${VERSION}`));
});

rule("relay", onChange("input_boolean.e2e_trigger", { to: "on" }), async () => {
  await forceOn("input_boolean.e2e_target");
  log.info(`E2E relayed ${VERSION}`);
});

rule("virtual", onStartup(), () => setState("sensor.e2e_virtual", VERSION));
