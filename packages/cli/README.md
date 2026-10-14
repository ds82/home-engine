# home-engine

Write your Home Assistant automations as TypeScript (or JavaScript) rules. home-engine runs
them next to Home Assistant, reloads them when you save a file, and gives them a small, typed
API from [`@home-engine/sdk`](https://www.npmjs.com/package/@home-engine/sdk).

> **Alpha.** Configuration and API can still change between releases.

```ts
import { log, onChange, rule } from "@home-engine/sdk";

rule("sun watcher", onChange("sun.sun"), (event) => {
  log.info(`The sun is now ${event.to?.state}`);
});
```

## Running it

Needs Node.js 24 or later. Create a long-lived access token in Home Assistant (your profile →
Security → Long-lived access tokens), then:

```sh
HA_URL=http://homeassistant.local:8123 HA_TOKEN=eyJ0eXAi... \
  RULES_DIR=./rules DATA_DIR=./data npx home-engine
```

| Variable    | Default  | Description                                                   |
| ----------- | -------- | ------------------------------------------------------------- |
| `HA_URL`    | –        | Home Assistant base URL                                       |
| `HA_TOKEN`  | –        | Long-lived access token (or `HA_TOKEN_FILE`)                  |
| `RULES_DIR` | `/rules` | Directory with your rule files                                |
| `DATA_DIR`  | `/data`  | Storage, build output and installed rule dependencies         |
| `HTTP_PORT` | `8080`   | Health and status endpoints (`GET /rules`); `0` disables them |
| `DRY_RUN`   | `false`  | Log service calls and state writes instead of executing them  |

> **Rules are trusted code.** They run inside the engine with its full rights, including access
> to `HA_TOKEN`. Only run rule files you wrote or reviewed.

## License

MIT
