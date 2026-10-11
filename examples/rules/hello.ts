// The quick-start rule: logs once the engine has loaded it, so you can see everything works.
import { getEntities, log, onStartup, rule } from "@home-engine/sdk";

rule("hello", onStartup(), () => {
  const lights = getEntities("light.*").length;
  log.info(`home-engine is running and sees ${lights} lights`);
});
