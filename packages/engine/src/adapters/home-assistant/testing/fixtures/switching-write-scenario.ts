// Run as a separate process by unawaited-writes.test.ts: a rule drops the promise of forceOn()
// for an entity Home Assistant rejects. The safety net must log it once as a failed write of
// that rule, described like the service call.

import { HaClient } from "../../client.js";
import { MockHomeAssistant } from "../mock-server.js";
import { createWrites } from "../../writes.js";
import { createLogger } from "../../../../core/logger.js";
import { RuleScopeImpl } from "../../../../core/rule-scope.js";
import { invoke } from "../../../../core/run-context.js";
import { installSafetyNet } from "../../../../core/safety-net.js";
import { TOKEN } from "../../../../core/testing/log-capture.js";

const log = createLogger({ level: "info", format: "json" });
installSafetyNet(log);

const ha = new MockHomeAssistant({ tokens: [TOKEN] });
ha.onService("light", "turn_on", (call) => {
  throw new Error(`Entity ${String(call.target?.entity_id)} not found`);
});
await ha.start();
const client = new HaClient(
  { baseUrl: ha.url, wsUrl: ha.wsUrl, restUrl: `${ha.url}/api`, token: TOKEN, supervisor: false },
  createLogger({ level: "fatal", format: "json" }),
);
await client.start();
const writes = createWrites(client, log);

const hall = new RuleScopeImpl("lights#hall", log);
invoke(hall, "body", () => {
  void writes.forceOn("light.missing");
});

setTimeout(() => {
  log.info("done");
  void client.stop().then(() => ha.stop());
}, 200);
