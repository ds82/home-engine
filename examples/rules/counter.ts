// A setup rule with storage: counts how often the backyard saw motion, across restarts.
import { listen, log, onChange, setup, store } from "@home-engine/sdk";

setup("motion counter", () => {
  log.info(`Motion seen ${store.get<number>("count") ?? 0} times so far`);

  listen(onChange("binary_sensor.movement_backyard", { to: "on" }), () => {
    const count = (store.get<number>("count") ?? 0) + 1;
    store.set("count", count);
    log.info(`Motion number ${count}`);
  });
});
