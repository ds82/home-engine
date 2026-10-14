# @home-engine/engine

The rule engine of home-engine: it connects to Home Assistant, loads TypeScript/JavaScript rule
files written with [`@home-engine/sdk`](https://www.npmjs.com/package/@home-engine/sdk), and
reloads them when you save a file.

> **Alpha.** Configuration and API can still change between releases.

To run the engine, install [`home-engine`](https://www.npmjs.com/package/home-engine) or use the
container image. This package is for embedding it:

```ts
import { HomeAssistantAdapter, startEngine } from "@home-engine/engine";
```

`@home-engine/engine/testing` contains a mock Home Assistant for tests of packages that talk to
it; it needs the `ws` package.

## License

MIT
