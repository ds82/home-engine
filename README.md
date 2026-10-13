# home-engine

Write your Home Assistant automations as TypeScript (or JavaScript) rules. home-engine runs
them in a container next to Home Assistant, reloads them when you save a file, and gives them a
small, typed API:

```ts
import { off, on, onChange, rule } from "@home-engine/sdk";

rule("hall light", onChange("binary_sensor.hall_motion", { to: "on" }), () => on("light.hall"));

rule("hall light off", onChange("binary_sensor.hall_motion", { to: "off", for: "5m" }), () =>
  off("light.hall"),
);
```

## Quick start

<!-- #region quick-start -->

1. **Create a token.** In Home Assistant, open your profile → Security → Long-lived access
   tokens → Create token. Copy it; Home Assistant shows it only once.
2. **Get the example.** Copy [`examples/docker-compose.yml`](examples/docker-compose.yml) and
   the [`examples/rules`](examples/rules) folder into a new directory, and create `.env` next to
   the Compose file:

   ```sh
   HA_URL=http://homeassistant.local:8123
   HA_TOKEN=eyJ0eXAi...
   ```

3. **Start it.**

   ```sh
   docker compose up -d
   docker compose logs -f
   ```

   You should see `home-engine is running and sees … lights`, a summary such as
   `Rules: 10 loaded, 0 disabled, 0 failed`, and `Engine ready`.

4. **Write your first rule.** Add `rules/hello-world.ts`:

   ```ts
   import { log, onChange, rule } from "@home-engine/sdk";

   rule("sun watcher", onChange("sun.sun"), (event) => {
     log.info(`The sun is now ${event.to?.state}`);
   });
   ```

   The engine picks the file up within a second; a typo shows up in the log with file and line.
   The example rules use the entity IDs of Home Assistant's demo integration; change them to
   yours or delete the files.

`curl localhost:8080/rules` lists every rule with its status, last error and next run.
For editor completion of your entity IDs, see [typings](docs/rules/typings.md).

> **Rules are trusted code.** They run inside the engine with its full rights: they can read
> its environment (including `HA_TOKEN`), use the network, and call any Home Assistant service
> the token allows. Only run rule files you wrote or reviewed, like you would with any script on
> your server.

<!-- #endregion quick-start -->

## Documentation

| Topic                                                     | Covers                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| [Rule files](docs/rules/files.md)                         | where rules live, `rule` and `setup`, IDs, reloading, packages |
| [Triggers](docs/rules/triggers.md)                        | state changes, holds (`for`), events, native triggers, startup |
| [Scheduling](docs/rules/scheduling.md)                    | `daily`, `cron`, `every`, sun events, `sleep` and `after`      |
| [Reading state and acting](docs/rules/actions.md)         | state helpers, `on`/`forceOn`, covers, services, dry run       |
| [History](docs/rules/history.md)                          | past states, averages, meters, long-term statistics            |
| [Storage](docs/rules/storage.md)                          | `store` and `shared`                                           |
| [Typings](docs/rules/typings.md)                          | generated types for your entities and services                 |
| [Configuration](docs/configuration.md)                    | environment variables and their defaults                       |
| [Health and status](docs/status.md)                       | health endpoints, `/rules` and rule statuses                   |
| [Coming from openHAB](docs/migrating-from-openhab.md)     | `@ds82/openhab` and openHAB JS rules side by side              |
| [Coming from AppDaemon](docs/migrating-from-appdaemon.md) | AppDaemon apps side by side                                    |
| [Performance](docs/performance.md)                        | load test and measured latency                                 |

## Configuration

The engine is configured through environment variables, such as `HA_URL`, `HA_TOKEN` and
`RULES_DIR`. [Configuration](docs/configuration.md) lists all of them with their defaults.

## Health and status

The engine serves health endpoints and `GET /rules`, which lists every rule with its status, on
port 8080. [Health and status](docs/status.md) describes them.

## Documentation site

The guides in `docs/` and an API reference generated from the SDK's doc comments build into a
static documentation site:

```sh
npm run docs:dev     # serve it locally with live reload
npm run docs:build   # build it into docs/.vitepress/dist
```

`DOCS_BASE` sets the base path when the site is served from a sub-path, e.g.
`DOCS_BASE=/home-engine/ npm run docs:build` for a GitHub Pages project site. Edit links, source
links and links to files outside `docs/` point to the `repository` URL in `docs/package.json`.
The build fails when an SDK export or one of its properties has no doc comment, or when a link
points to a missing page or heading. CI builds the documentation site on every push and keeps it
as the `docs-site` artifact of the run.

## License

MIT
