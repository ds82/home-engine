import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/testing.ts"],
  format: ["esm"],
  target: "node24",
  dts: true,
  sourcemap: true,
  clean: true,
});
