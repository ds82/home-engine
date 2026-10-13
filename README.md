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
| [Coming from openHAB](docs/migrating-from-openhab.md)     | `@ds82/openhab` and openHAB JS rules side by side              |
| [Coming from AppDaemon](docs/migrating-from-appdaemon.md) | AppDaemon apps side by side                                    |
| [Performance](docs/performance.md)                        | load test and measured latency                                 |

## Configuration

The engine is configured through environment variables. Empty values count as unset.
Problems are reported together at startup, and the engine exits before connecting.

| Variable           | Default             | Description                                                                                                                            |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `HA_URL`           | –                   | Home Assistant base URL, e.g. `http://homeassistant.local:8123`. Required unless running as an add-on.                                 |
| `HA_URL_FILE`      | –                   | File containing `HA_URL` (Docker/Kubernetes secret). Do not set together with `HA_URL`.                                                |
| `HA_TOKEN`         | –                   | Long-lived access token. Required unless running as an add-on.                                                                         |
| `HA_TOKEN_FILE`    | –                   | File containing `HA_TOKEN`; surrounding whitespace is trimmed. Do not set together with `HA_TOKEN`.                                    |
| `SUPERVISOR_TOKEN` | –                   | Set by the Home Assistant Supervisor in add-on mode. Used when `HA_URL`/`HA_TOKEN` are not set.                                        |
| `RULES_DIR`        | `/rules`            | Directory scanned for rule files. Must exist and be readable.                                                                          |
| `DATA_DIR`         | `/data`             | Directory for storage, build output and installed rule dependencies.                                                                   |
| `LOG_LEVEL`        | `info`              | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`.                                                                             |
| `LOG_FORMAT`       | `pretty`            | `pretty` for humans, `json` for log collectors.                                                                                        |
| `HOT_RELOAD`       | `true`              | Reload rule files when they change.                                                                                                    |
| `WATCH_POLL`       | `auto`              | `auto` uses native file watching and falls back to polling; `true` always polls (Docker Desktop, network shares); `false` never polls. |
| `DISABLED_RULES`   | –                   | Comma-separated glob patterns on rule IDs that are loaded but not started, e.g. `lights/*, climate#heating`.                           |
| `DRY_RUN`          | `false`             | Log service calls and state writes instead of executing them.                                                                          |
| `TIME_ZONE`        | from Home Assistant | IANA time zone for schedules, e.g. `Europe/Berlin`.                                                                                    |
| `HTTP_PORT`        | `8080`              | Port of the health and status endpoints; `0` disables them.                                                                            |
| `NPM_INSTALL`      | `true`              | Install the dependencies from `RULES_DIR/package.json` at startup.                                                                     |

Boolean variables accept `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`). Rule code can
read any other environment variable of the engine process, e.g. API keys for notifications.

## Health and status

The engine serves three read-only JSON endpoints on `HTTP_PORT`:

- `GET /health/live`: 200 while the event loop responds; the container health check uses it.
- `GET /health/ready`: 200 once the engine is connected to Home Assistant and has loaded the
  rule files. Rule statuses do not affect it.
- `GET /rules`: every rule with its file, status, last load and run, last error, active
  triggers, pending timers and next run.

A rule's `status` is one of:

| Status     | Meaning                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `starting` | A setup rule whose async setup function has not finished yet; its listeners already fire.         |
| `running`  | Started and armed.                                                                                |
| `disabled` | Switched off by `enabled: false` or `DISABLED_RULES`.                                             |
| `failed`   | Its setup failed or timed out. `lastError` keeps the error name: `ReferenceError: foo is not ...` |

A trigger Home Assistant rejects does not stop the rule: it stays `running`, and
`triggerErrors` lists each rejected trigger as `{ kind, position, trigger, message }`.
`position` counts from 1 in the rule's trigger list (or the listener's, in a setup rule), and
`trigger` describes it briefly, e.g. `ha-trigger numeric_state`.

## License

MIT
