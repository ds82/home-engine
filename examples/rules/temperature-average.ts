// History: the 24-hour average outside temperature, every hour, as a virtual sensor that
// dashboards can show. Virtual entities are lost when Home Assistant restarts; the engine
// sets them again on reconnect, and this rule refreshes it at startup.
import { averageSince, every, log, onStartup, rule, setState } from "@home-engine/sdk";

const sensor = "sensor.outside_temperature";

rule("outside temperature average", [onStartup(), every("1h")], async () => {
  const average = await averageSince(sensor, "24h");
  if (average === undefined) {
    log.warn(`No numeric history for ${sensor} yet`);
    return;
  }
  log.info(`Outside temperature, 24 h average: ${average.toFixed(1)} °C`);
  await setState("sensor.home_engine_outside_average", average.toFixed(1), {
    friendly_name: "Outside temperature (24 h average)",
    unit_of_measurement: "°C",
  });
});
