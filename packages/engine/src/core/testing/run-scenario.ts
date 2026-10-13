// Runs a test scenario in its own Node process, bundled with esbuild: unhandled rejections
// inside vitest would fail the test run. Each JSON line on stdout is one log entry.

import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { build } from "esbuild";

/** Bundles `entry` into `dir` and runs it; returns its log entries and exit code. */
export async function runScenario(
  dir: string,
  entry: string,
): Promise<{ entries: Array<Record<string, unknown>>; exitCode: number }> {
  const outfile = join(dir, `${basename(entry, ".ts")}.mjs`);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  let stdout: string;
  let exitCode: number;
  try {
    stdout = execFileSync(process.execPath, [outfile], { encoding: "utf8" });
    exitCode = 0;
  } catch (err) {
    const e = err as { status: number; stdout: string };
    stdout = e.stdout;
    exitCode = e.status;
  }
  const entries = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { entries, exitCode };
}
