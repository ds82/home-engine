import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockHomeAssistant } from "@home-engine/engine/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchTypingsInput, websocketUrl } from "./fetch.js";
import { generateTypings } from "./generate.js";

const TOKEN = "typegen-test-token";

describe("typegen", () => {
  let ha: MockHomeAssistant;
  let typings: string;

  beforeAll(async () => {
    ha = new MockHomeAssistant({ tokens: [TOKEN], version: "2026.10.1" });
    ha.setState("light.kitchen", "on", { brightness: 200, friendly_name: "Kitchen" });
    ha.setState("sensor.temperature", "21.5", { unit_of_measurement: "°C", attribution: null });
    ha.setState("cover.bath", "open", { current_position: 60, supported_features: 15 });
    ha.setState("binary_sensor.front_door", "off", { device_class: "door" });
    ha.setState("person.dennis", "home", { source: "device_tracker.phone" });
    ha.onService("light", "turn_on", () => undefined, {
      fields: {
        brightness_pct: { selector: { number: { min: 0, max: 100 } } },
        rgb_color: { selector: { color_rgb: {} } },
        advanced_fields: {
          collapsed: true,
          fields: { flash: { selector: { select: { options: ["short", "long"] } } } },
        },
      },
    });
    ha.onService("notify", "mobile_app_phone", () => undefined, {
      fields: {
        message: { required: true, selector: { text: {} } },
        title: { selector: { text: {} } },
        data: { selector: { object: {} } },
      },
    });
    ha.onService("climate", "set_hvac_mode", () => undefined, {
      fields: {
        hvac_mode: {
          selector: { select: { options: [{ value: "heat", label: "Heat" }, "off"] } },
        },
      },
    });
    await ha.start();
    typings = generateTypings(await fetchTypingsInput({ url: ha.url, token: TOKEN }));
  });

  afterAll(async () => {
    await ha.stop();
  });

  it("generates a declaration file from the mock server's states and services", () => {
    expect(typings).toMatchSnapshot();
  });

  it("lists every entity, domain and service", () => {
    for (const id of ["light.kitchen", "sensor.temperature", "person.dennis"]) {
      expect(typings).toContain(`"${id}": HassEntity<`);
    }
    expect(typings).toContain('"notify.mobile_app_phone": {');
    expect(typings).toContain('"message": string;');
    expect(typings).toContain('"flash"?: "short" | "long";');
    expect(typings).toMatch(/type HassDomain = .*"binary_sensor".*"notify"/);
  });

  it("rejects an invalid token with a clear error", async () => {
    await expect(fetchTypingsInput({ url: ha.url, token: "wrong" })).rejects.toThrow(
      /rejected the access token/,
    );
  });

  it("derives the WebSocket URL from the base URL", () => {
    expect(websocketUrl("http://ha.local:8123")).toBe("ws://ha.local:8123/api/websocket");
    expect(websocketUrl("https://ha.example.com/")).toBe("wss://ha.example.com/api/websocket");
  });

  describe("in a rules project", () => {
    let dir: string;

    beforeAll(() => {
      // Inside the repository, so `@types/node` and `typescript` resolve.
      const cache = fileURLToPath(new URL("../node_modules/.cache", import.meta.url));
      mkdirSync(cache, { recursive: true });
      dir = mkdtempSync(join(cache, "typegen-"));
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("makes an unknown entity ID a compile error and keeps known ones valid", () => {
      const sdk = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));
      writeFileSync(join(dir, "ha-types.d.ts"), typings);
      writeFileSync(
        join(dir, "rules.ts"),
        [
          'import { call, getEntity, on } from "@home-engine/sdk";',
          'void on("light.kitchen");',
          'void on("light.does_not_exist");',
          'void call("notify.mobile_app_phone", { message: "hi" });',
          'const pos: number | undefined = getEntity("cover.bath")?.attributes.current_position;',
          "void pos;",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2023",
            lib: ["ES2023"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            types: ["node"],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            allowImportingTsExtensions: true,
            paths: { "@home-engine/sdk": [sdk] },
          },
          include: ["*.ts"],
        }),
      );
      const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
      let output = "";
      try {
        execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], {
          encoding: "utf8",
        });
      } catch (err) {
        output = String((err as { stdout?: string }).stdout ?? err);
      }
      const errors = output.split("\n").filter((l) => l.includes("error TS"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/rules\.ts\(3,\d+\).*"light\.does_not_exist"/);
    });
  });
});
