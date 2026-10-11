# home-engine

A rule engine that runs your TypeScript/JavaScript rule files against Home Assistant. It is
in early development; a quick start follows once the engine runs end to end.

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

## License

MIT
