import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantAdapter } from "./adapters/home-assistant/adapter.js";
import { MockHomeAssistant } from "./adapters/home-assistant/testing/mock-server.js";
import { ConfigError } from "./core/config.js";
import { checkDataDir, startEngine, type Engine } from "./core/engine.js";
import { FakeAdapter } from "./core/testing/fake-adapter.js";
import { TOKEN } from "./core/testing/log-capture.js";

/** Collects JSON log lines. */
function logSink(): { stream: Writable; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const lines = (): Array<Record<string, unknown>> =>
    chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, lines };
}

describe("engine startup", () => {
  let root: string;
  let rulesDir: string;
  let dataDir: string;
  let engine: Engine | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "home-engine-e2e-"));
    rulesDir = join(root, "rules");
    dataDir = join(root, "data");
    mkdirSync(rulesDir);
    mkdirSync(dataDir);
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    RULES_DIR: rulesDir,
    DATA_DIR: dataDir,
    LOG_FORMAT: "json",
    LOG_LEVEL: "info",
    HOT_RELOAD: "false",
    NPM_INSTALL: "false",
    ...extra,
  });

  it("boots the core with the fake adapter, loads a rule and reports ready", async () => {
    writeFileSync(
      join(rulesDir, "boot.ts"),
      `import { log, onStartup, rule, store } from "@home-engine/sdk";
       rule("boot", onStartup(), () => {
         store.set("booted", true);
         log.info("booted", { from: "test" });
       });`,
    );
    const sink = logSink();
    engine = await startEngine({
      env: env(),
      adapter: new FakeAdapter(),
      logDestination: sink.stream,
      httpListenPort: 0,
      httpHost: "127.0.0.1",
    });

    expect(engine.isReady()).toBe(true);
    expect(engine.registry.listRules().map((r) => [r.id, r.status])).toEqual([
      ["boot#boot", "running"],
    ]);
    const ready = await fetch(`http://127.0.0.1:${engine.httpPort}/health/ready`);
    expect(ready.status).toBe(200);
    const rules = (await (await fetch(`http://127.0.0.1:${engine.httpPort}/rules`)).json()) as {
      engine: Record<string, unknown>;
    };
    expect(rules.engine).toMatchObject({ backend: "fake", watchMode: "disabled" });

    await vi.waitFor(() =>
      expect(sink.lines()).toContainEqual(
        expect.objectContaining({ source: "boot#boot", message: "booted", from: "test" }),
      ),
    );
    expect(sink.lines().map((l) => l.message)).toEqual(
      expect.arrayContaining([
        "Effective configuration",
        "Rules: 1 loaded, 0 disabled, 0 failed",
        "Engine ready",
      ]),
    );

    await engine.stop();
    engine = undefined;
    const stored = JSON.parse(readFileSync(join(dataDir, "storage", "boot%23boot.json"), "utf8"));
    expect(stored.values).toEqual({ booted: true });
  });

  it("rejects invalid configuration before starting anything", async () => {
    const adapter = new FakeAdapter();
    await expect(
      startEngine({ env: env({ LOG_LEVEL: "loud", FAKE_FAIL: "x" }), adapter }),
    ).rejects.toThrow(ConfigError);
    expect(adapter.started).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses to start when the data directory is not writable, naming it and the UID",
    () => {
      const locked = join(root, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      try {
        expect(() => checkDataDir(locked)).toThrow(
          new RegExp(`DATA_DIR: directory ${locked} is not writable by UID ${process.getuid?.()}`),
        );
        // A missing directory is created.
        expect(() => checkDataDir(join(root, "new", "data"))).not.toThrow();
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  describe("against the Home Assistant mock server", () => {
    let ha: MockHomeAssistant;

    beforeEach(async () => {
      ha = new MockHomeAssistant({ tokens: [TOKEN] });
      ha.setState("binary_sensor.porch_motion", "off");
      ha.setState("light.porch", "off");
      await ha.start();
    });

    afterEach(async () => {
      await engine?.stop();
      engine = undefined;
      await ha.stop();
    });

    it("loads a rule that turns on a light when motion is detected", async () => {
      writeFileSync(
        join(rulesDir, "porch.ts"),
        `import { on, onChange, rule } from "@home-engine/sdk";
         rule("motion light", onChange("binary_sensor.porch_motion", { to: "on" }), async () => {
           await on("light.porch", { brightness_pct: 60 });
         });`,
      );
      const sink = logSink();
      engine = await startEngine({
        env: env({ HA_URL: ha.url, HA_TOKEN: TOKEN }),
        adapter: new HomeAssistantAdapter(),
        logDestination: sink.stream,
        httpListenPort: 0,
        httpHost: "127.0.0.1",
      });
      expect(engine.isReady()).toBe(true);

      ha.setState("binary_sensor.porch_motion", "on");
      await vi.waitFor(() => expect(ha.getState("light.porch")?.state).toBe("on"));
      expect(ha.calls).toEqual([
        expect.objectContaining({
          domain: "light",
          service: "turn_on",
          service_data: { brightness_pct: 60 },
          target: { entity_id: "light.porch" },
        }),
      ]);
      // The token never reaches the log.
      expect(JSON.stringify(sink.lines())).not.toContain(TOKEN);
    });

    it("shares one connection between all rules", async () => {
      for (const room of ["hall", "kitchen", "porch"]) {
        writeFileSync(
          join(rulesDir, `${room}.ts`),
          `import { onChange, rule, setup, listen } from "@home-engine/sdk";
           rule("a", onChange("binary_sensor.porch_motion"), () => {});
           setup("b", () => { listen(onChange("light.porch"), () => {}); });`,
        );
      }
      engine = await startEngine({
        env: env({ HA_URL: ha.url, HA_TOKEN: TOKEN }),
        adapter: new HomeAssistantAdapter(),
        logDestination: logSink().stream,
        httpListenPort: 0,
      });
      expect(engine.registry.listRules()).toHaveLength(6);
      expect(ha.connectionCount).toBe(1);
    });

    it("schedules in TIME_ZONE when set, else in Home Assistant's time zone", async () => {
      ha.config.time_zone = "Asia/Tokyo";
      writeFileSync(
        join(rulesDir, "tz.ts"),
        `import { daily, rule } from "@home-engine/sdk";
         rule("morning", daily("07:00"), () => {});`,
      );
      const nextRun = async (extra: Record<string, string>): Promise<Date | undefined> => {
        engine = await startEngine({
          env: env({ HA_URL: ha.url, HA_TOKEN: TOKEN, ...extra }),
          adapter: new HomeAssistantAdapter(),
          logDestination: logSink().stream,
          httpListenPort: 0,
        });
        const next = engine.registry.rule("tz#morning")?.nextRun;
        await engine.stop();
        engine = undefined;
        return next;
      };
      const localTime = (at: Date | undefined, timeZone: string): string | undefined =>
        at?.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
      expect(localTime(await nextRun({}), "Asia/Tokyo")).toBe("07:00");
      expect(localTime(await nextRun({ TIME_ZONE: "America/New_York" }), "America/New_York")).toBe(
        "07:00",
      );
    });
  });
});
