// Covers follow the sun: down 30 minutes after sunset (leaving a gap), up at sunrise.
// Positions are Home Assistant's: 0 is closed, 100 is open.
import { down, isSunUp, log, onStartup, rule, sun, up } from "@home-engine/sdk";

const cover = "cover.living_room_window";

rule("cover down after sunset", sun("sunset", { offset: "30m" }), () => down(cover, 20));
rule("cover up at sunrise", sun("sunrise"), () => up(cover));

rule("cover status at start", onStartup(), () => {
  log.info(`The sun is ${isSunUp() ? "up" : "down"}; ${cover} follows it`);
});
