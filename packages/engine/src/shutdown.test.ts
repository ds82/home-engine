import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockHomeAssistant } from "./adapters/home-assistant/testing/mock-server.js";
import { TOKEN } from "./core/testing/log-capture.js";

// The engine runs as a real process (the bundled CLI), so signals and exit codes are real.
describe("graceful shutdown of the engine process", () => {
  let cache: string;
  let cli: string;
  let root: string;
  let ha: MockHomeAssistant;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    // Inside the package, so the bundle resolves its external packages normally.
    const base = fileURLToPath(new URL("../node_modules/.cache", import.meta.url));
    mkdirSync(base, { recursive: true });
    cache = mkdtempSync(join(base, "he-shutdown-"));
    cli = join(cache, "cli.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./cli.ts", import.meta.url))],
      outfile: cli,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
  });

  afterAll(() => rmSync(cache, { recursive: true, force: true }));

  beforeEach(async () => {
    root = mkdtempSync(join(cache, "run-"));
    mkdirSync(join(root, "rules"));
    mkdirSync(join(root, "data"));
    ha = new MockHomeAssistant({ tokens: [TOKEN] });
    await ha.start();
  });

  afterEach(async () => {
    child?.kill("SIGKILL");
    child = undefined;
    await ha.stop();
    rmSync(root, { recursive: true, force: true });
  });

  interface Run {
    lines: Array<Record<string, unknown>>;
    waitFor(message: string): Promise<void>;
    exit: Promise<{ code: number | null; ms: number }>;
  }

  function startEngine(haUrl = ha.url): Run {
    const proc = spawn(process.execPath, [cli], {
      env: {
        PATH: process.env.PATH,
        HA_URL: haUrl,
        HA_TOKEN: TOKEN,
        RULES_DIR: join(root, "rules"),
        DATA_DIR: join(root, "data"),
        LOG_FORMAT: "json",
        HOT_RELOAD: "false",
        NPM_INSTALL: "false",
        HTTP_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    const lines: Array<Record<string, unknown>> = [];
    const waiters: Array<{ message: string; resolve: () => void }> = [];
    let buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.startsWith("{")) continue;
        const line = JSON.parse(part) as Record<string, unknown>;
        lines.push(line);
        for (const w of waiters.filter((w) => line.message === w.message)) w.resolve();
      }
    });
    let signalledAt = 0;
    const exit = new Promise<{ code: number | null; ms: number }>((resolve) =>
      proc.on("exit", (code) => resolve({ code, ms: Date.now() - signalledAt })),
    );
    const originalKill = proc.kill.bind(proc);
    proc.kill = (signal?: NodeJS.Signals | number) => {
      signalledAt = Date.now();
      return originalKill(signal);
    };
    return {
      lines,
      exit,
      waitFor: (message) =>
        lines.some((l) => l.message === message)
          ? Promise.resolve()
          : new Promise((resolve) => waiters.push({ message, resolve })),
    };
  }

  it("runs teardowns, flushes storage and exits 0 on SIGTERM", async () => {
    writeFileSync(
      join(root, "rules", "counter.ts"),
      `import { log, onDispose, onStartup, rule, store } from "@home-engine/sdk";
       rule("counter", onStartup(), () => {
         store.set("count", 1);
         onDispose(() => log.info("teardown ran"));
       });`,
    );
    const run = startEngine();
    await run.waitFor("Engine ready");
    child?.kill("SIGTERM");
    const { code, ms } = await run.exit;
    expect(code).toBe(0);
    expect(ms).toBeLessThan(10_000);
    expect(run.lines.map((l) => l.message)).toEqual(
      expect.arrayContaining(["Received SIGTERM", "teardown ran", "Shutdown complete"]),
    );
    const stored = JSON.parse(
      readFileSync(join(root, "data", "storage", "counter%23counter.json"), "utf8"),
    ) as { values: unknown };
    expect(stored.values).toEqual({ count: 1 });
  }, 20_000);

  it("exits 0 on SIGINT while still waiting for Home Assistant", async () => {
    // Nothing listens there: the engine keeps retrying until the signal.
    const run = startEngine("http://127.0.0.1:9");
    await new Promise((r) => setTimeout(r, 500));
    child?.kill("SIGINT");
    expect((await run.exit).code).toBe(0);
  }, 20_000);

  it("exits non-zero after 10 s and names the rule whose teardown hangs", async () => {
    writeFileSync(
      join(root, "rules", "stuck.ts"),
      `import { onDispose, onStartup, rule, store } from "@home-engine/sdk";
       rule("stuck", onStartup(), () => {
         store.set("seen", true);
         onDispose(() => new Promise(() => {}));
       });`,
    );
    const run = startEngine();
    await run.waitFor("Engine ready");
    child?.kill("SIGTERM");
    const { code, ms } = await run.exit;
    expect(code).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(9_500);
    expect(ms).toBeLessThan(13_000);
    expect(run.lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Shutdown did not finish within 10 s; blocked by stuck#stuck",
        blockedBy: ["stuck#stuck"],
      }),
    );
    // Stored values are written even though shutdown timed out.
    const stored = JSON.parse(
      readFileSync(join(root, "data", "storage", "stuck%23stuck.json"), "utf8"),
    ) as { values: unknown };
    expect(stored.values).toEqual({ seen: true });
  }, 30_000);
});
