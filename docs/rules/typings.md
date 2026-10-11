# Typings for your Home Assistant

Without extra setup, entity IDs and service names in rules are plain strings: a typo such as
`on("light.kitchn")` only shows up when the rule runs. `typegen` reads your Home Assistant's
entities and services and writes a declaration file. With it, your editor completes entity IDs
and service fields, and TypeScript reports unknown ones:

```text
kitchen.ts(3,9): error TS2345: Argument of type '"light.kitchn"' is not assignable to
parameter of type '"light.kitchen" | "light.hallway" | …'.
```

The file contains:

- every entity ID with its state type (`"on" | "off" | …` for lights, switches and binary
  sensors, open/closed states for covers) and the attributes it currently has,
- every service (`light.turn_on`, `notify.mobile_app_phone`, …) with its fields, typed from
  Home Assistant's field descriptions; required fields are marked as required,
- the domains of your instance as `HassDomain`.

The engine itself does not need the file; it only helps while writing rules. Rules keep working
without it.

## Generating the file

You need the same URL and long-lived access token as the engine (create the token in Home
Assistant under your profile → Security → Long-lived access tokens).

### Locally with npx

In your rules directory:

```sh
HA_URL=http://homeassistant.local:8123 HA_TOKEN=eyJ0eXAi... \
  npx @home-engine/typegen --out ha-types.d.ts
```

`--url` and `--token` work as well; `HA_TOKEN_FILE` reads the token from a file. Without `--out`
the typings are printed to stdout.

### With the container image

The image contains typegen, so you do not need Node.js on your machine:

```sh
docker run --rm -e HA_URL -e HA_TOKEN ghcr.io/home-engine/home-engine typegen > rules/ha-types.d.ts
```

`-e HA_URL -e HA_TOKEN` passes the variables from your shell. In the Home Assistant add-on,
`SUPERVISOR_TOKEN` is used automatically.

## Using the file

Put `ha-types.d.ts` in your rules directory. The engine ignores `*.d.ts` files when loading
rules. For editor support, install the SDK there and add a `tsconfig.json`:

```sh
npm install --save-dev @home-engine/sdk typescript
```

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts"]
}
```

`npx tsc` then checks all rules against your instance. Both packages are development
dependencies: the engine provides the SDK at runtime, installs only regular `dependencies` and
ignores a `node_modules` folder in the rules directory.

Run typegen again after adding entities or integrations; the output is sorted and has no
timestamp, so a diff shows exactly what changed. Entities you remove disappear from the file
and rules that still use them stop compiling, which is usually what you want to know.
