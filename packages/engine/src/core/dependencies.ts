// User npm dependencies (rule-files: User npm dependencies; design D9). A package.json in the
// rules directory is installed into <DATA_DIR>/deps at startup, and <DATA_DIR>/node_modules
// links to it, so rule bundles in <DATA_DIR>/.build resolve bare imports by walking up. The
// rules directory is only read (it may be mounted read-only), and a node_modules in it is
// ignored. A hash of manifest and lockfile skips reinstalling when nothing changed.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "./logger.js";

const run = promisify(execFile);

export type InstallResult = "no-manifest" | "disabled" | "unchanged" | "installed" | "failed";

export interface InstallOptions {
  rulesDir: string;
  dataDir: string;
  log: Logger;
  /** NPM_INSTALL; when false nothing is installed. */
  enabled?: boolean;
  /** Extra environment for npm (tests use an offline cache). */
  env?: NodeJS.ProcessEnv;
  /** npm executable. Default `npm`. */
  npm?: string;
}

export async function installRuleDependencies(options: InstallOptions): Promise<InstallResult> {
  const { rulesDir, dataDir, log } = options;
  const manifest = join(rulesDir, "package.json");
  if (!existsSync(manifest)) {
    return "no-manifest";
  }
  if (options.enabled === false) {
    log.info("NPM_INSTALL=false: not installing rule dependencies");
    return "disabled";
  }

  const lockfile = join(rulesDir, "package-lock.json");
  const hasLock = existsSync(lockfile);
  const depsDir = join(dataDir, "deps");
  const hashFile = join(depsDir, ".installed-hash");
  const installed = join(depsDir, "node_modules");

  const hash = createHash("sha256")
    .update(await readFile(manifest))
    .update(hasLock ? await readFile(lockfile) : "")
    .digest("hex");
  const previous = existsSync(hashFile) ? (await readFile(hashFile, "utf8")).trim() : undefined;
  if (previous === hash && existsSync(installed)) {
    await linkNodeModules(dataDir, installed);
    log.info("Rule dependencies unchanged; skipping npm install");
    return "unchanged";
  }

  await mkdir(depsDir, { recursive: true });
  await copyFile(manifest, join(depsDir, "package.json"));
  if (hasLock) {
    await copyFile(lockfile, join(depsDir, "package-lock.json"));
  } else {
    await rm(join(depsDir, "package-lock.json"), { force: true });
  }
  await rm(hashFile, { force: true });

  const args = [hasLock ? "ci" : "install", "--omit=dev", "--no-audit", "--no-fund"];
  log.info({ command: `npm ${args.join(" ")}` }, "Installing rule dependencies");
  try {
    const { stdout, stderr } = await run(options.npm ?? "npm", args, {
      cwd: depsDir,
      env: { ...process.env, ...options.env },
      maxBuffer: 16 * 1024 * 1024,
    });
    log.debug({ stdout, stderr }, "npm output");
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    log.error(
      { stdout: e.stdout, stderr: e.stderr },
      `Installing rule dependencies failed; rule files that import them will fail to load: ${e.message.split("\n")[0]}`,
    );
    return "failed";
  }

  await writeFile(hashFile, `${hash}\n`);
  await linkNodeModules(dataDir, installed);
  log.info("Rule dependencies installed");
  return "installed";
}

/** Points <DATA_DIR>/node_modules at the installed packages. */
async function linkNodeModules(dataDir: string, target: string): Promise<void> {
  const link = join(dataDir, "node_modules");
  const stat = await lstat(link).catch(() => undefined);
  if (stat?.isSymbolicLink()) {
    return;
  }
  if (stat) {
    await rm(link, { recursive: true, force: true });
  }
  await symlink(target, link, "dir");
}
