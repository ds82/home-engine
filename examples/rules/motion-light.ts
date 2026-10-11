// Motion light: on when motion is detected, off after five minutes without motion.
// Replace the entity IDs with your own (these exist in Home Assistant's demo integration).
import { off, on, onChange, rule } from "@home-engine/sdk";

const motion = "binary_sensor.movement_backyard";
const light = "light.bed_light";

rule("motion light on", onChange(motion, { to: "on" }), () => on(light));

// `for` holds survive reloads and restarts: a light still waiting to go off does.
rule("motion light off", onChange(motion, { to: "off", for: "5m" }), () => off(light));
