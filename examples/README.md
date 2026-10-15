# Examples

A Compose file and example rules to start from. The entity IDs are those of Home Assistant's
`demo` integration; replace them with your own.
`package.json` and `tsconfig.json` here only type-check the examples inside this repository;
the `rules` folder itself contains nothing but rules.

| File                           | Shows                                                         |
| ------------------------------ | ------------------------------------------------------------- |
| `rules/hello.ts`               | the quick-start rule: logs that the engine is running         |
| `rules/motion-light.ts`        | a motion light that turns off after five minutes (`for`)      |
| `rules/sunset-cover.ts`        | a cover that follows sunset and sunrise (`sun`, `up`, `down`) |
| `rules/rooms.ts`               | rules generated in a loop, one per room                       |
| `rules/counter.ts`             | a setup rule with `listen` and a counter kept in `store`      |
| `rules/temperature-average.ts` | a 24-hour average from history, published with `setState`     |

## Quick start

1. Copy `docker-compose.yml` and the `rules` folder into a new directory.
2. Create a long-lived access token in Home Assistant (your profile → Security → Long-lived
   access tokens) and put it next to the Compose file in `.env`:

   ```sh
   HA_URL=http://homeassistant.local:8123
   HA_TOKEN=eyJ0eXAi...
   ```

3. Start the engine and watch its log:

   ```sh
   docker compose up -d
   docker compose logs -f
   ```

   Once it has connected you should see:

   ```text
   [hello#hello] home-engine is running and sees 6 lights
   [engine] Rules: 10 loaded, 0 disabled, 0 failed
   [engine] Engine ready
   ```

Edit a file in `rules/` and the engine reloads it within a second. `curl localhost:8080/rules`
lists every rule with its status.

To run another image, such as one you built yourself or a pinned version, set
`HOME_ENGINE_IMAGE` in `.env` (default `ghcr.io/ds82/home-engine:latest`):

```sh
HOME_ENGINE_IMAGE=home-engine:local
```

`scripts/container-smoke.sh` runs this quick start against a mock Home Assistant with the image
it builds.

## Verified quick start

Run on 2026-10-11 against Home Assistant 2026.6.0 in a container
(`ghcr.io/home-assistant/home-assistant:stable` with `default_config:` and `demo:`, onboarded by
`scripts/ha-onboard.mjs`), with the image built from this repository at commit time, the
Compose file and rules copied into an empty directory and only `.env` added:

- `docker compose up -d`: the engine retried until Home Assistant was reachable on the network,
  connected, loaded all six files (10 rules, 0 failed) and logged
  `home-engine is running and sees 6 lights`.
- `temperature-average.ts` read the history and created `sensor.home_engine_outside_average`
  (15.6 °C) in Home Assistant.
- Setting `binary_sensor.movement_backyard` to `on` turned `light.bed_light` on and logged
  `Motion number 1` from the counter's `store`.
- Opening `cover.kitchen_window` turned `light.kitchen_lights` off (factory rule).
- `docker compose stop` ran the shutdown (`Shutdown complete`) and the container exited with
  code 0.
