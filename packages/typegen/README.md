# @home-engine/typegen

Generates a TypeScript declaration file with your Home Assistant's entity IDs, domains and
services, so [`@home-engine/sdk`](https://www.npmjs.com/package/@home-engine/sdk) completes and
checks them in your editor.

> **Alpha.** The output format can still change between releases.

In your rules directory:

```sh
HA_URL=http://homeassistant.local:8123 HA_TOKEN=eyJ0eXAi... \
  npx @home-engine/typegen --out ha-types.d.ts
```

`--url` and `--token` override the environment; `HA_TOKEN_FILE` reads the token from a file.
Without `--out` the typings are printed to stdout. The output is sorted and has no timestamp, so
a diff shows exactly what changed in your instance.

## License

MIT
