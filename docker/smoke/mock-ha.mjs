// Mock Home Assistant for the container smoke test; runs in the image's build stage.
// Switches the porch motion sensor on and off until the engine turns the porch light on.
import { MockHomeAssistant } from "/src/packages/engine/dist/testing.js";

const ha = new MockHomeAssistant({ tokens: ["smoke-token"], host: "0.0.0.0" });
ha.setState("binary_sensor.porch_motion", "off");
ha.setState("light.porch", "off");
await ha.start(8123);
console.log("MOCK_READY");

let motion = false;
setInterval(() => {
  motion = !motion;
  ha.setState("binary_sensor.porch_motion", motion ? "on" : "off");
  if (ha.getState("light.porch")?.state === "on") {
    console.log("LIGHT_ON");
  }
}, 1000);
process.on("SIGTERM", () => process.exit(0));
