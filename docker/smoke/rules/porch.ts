import ms from "ms";
import { log, on, onChange, onStartup, rule } from "@home-engine/sdk";

rule("hello", onStartup(), () => {
  log.info(`smoke rule running: two days are ${ms("2 days")} ms`);
});

rule("porch light", onChange("binary_sensor.porch_motion", { to: "on" }), () => on("light.porch"));
