# @home-engine/sdk

Types and rule API for [home-engine](https://www.npmjs.com/package/home-engine), which runs
Home Assistant automations written in TypeScript or JavaScript.

> **Alpha.** The API can still change between releases.

```ts
import { off, on, onChange, rule } from "@home-engine/sdk";

rule("hall light", onChange("binary_sensor.hall_motion", { to: "on" }), () => on("light.hall"));

rule("hall light off", onChange("binary_sensor.hall_motion", { to: "off", for: "5m" }), () =>
  off("light.hall"),
);
```

The engine provides the SDK at runtime, so in your rules directory you only need it for editor
completion and type checking:

```sh
npm install --save-dev @home-engine/sdk typescript
```

For completion of your own entity IDs and services, generate typings with
[`@home-engine/typegen`](https://www.npmjs.com/package/@home-engine/typegen).

## License

MIT
