// Turning a rule file into something Node can import, again and again (design D3).
// Each rule file is bundled with esbuild: local imports (helper modules) are inlined, npm
// packages stay external, the SDK import is rewritten to the engine's runtime, and an inline
// source map keeps stack traces on the original .ts lines. The output file name carries a
// content hash, so a changed file gets a new module URL and a fresh evaluation on reload.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { SDK_RUNTIME_KEY, installedSdkRuntime } from "./sdk-runtime.js";

export interface BundleResult {
  /** The written bundle. */
  outfile: string;
  /** Absolute paths of the local source files the bundle contains (entry and helpers). */
  inputs: string[];
}

export interface BundleOptions {
  rulesDir: string;
  /** Rule file relative to `rulesDir`. */
  file: string;
  /** Where bundles are written (`<DATA_DIR>/.build`). */
  buildDir: string;
}

/** Bundles one rule file and writes it to a content-hashed path in `buildDir`. */
export async function bundleRuleFile(options: BundleOptions): Promise<BundleResult> {
  const rulesDir = resolve(options.rulesDir);
  const entry = join(rulesDir, options.file);
  // Same directory as the final hashed file, so source map paths resolve to the sources.
  const provisional = join(resolve(options.buildDir), `${options.file}.mjs`);
  const result = await build({
    entryPoints: [entry],
    outfile: provisional,
    absWorkingDir: rulesDir,
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    packages: "external",
    sourcemap: "inline",
    sourcesContent: true,
    metafile: true,
    logLevel: "silent",
    plugins: [sdkPlugin()],
  });

  const code = result.outputFiles[0]?.contents;
  if (!code) throw new Error(`esbuild produced no output for ${options.file}`);
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
  const outfile = join(resolve(options.buildDir), `${options.file}.${hash}.mjs`);
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, code);

  const inputs = Object.keys(result.metafile.inputs)
    .filter((p) => !p.startsWith("home-engine-sdk:"))
    .map((p) => resolve(rulesDir, p));
  return { outfile, inputs };
}

/** Imports a bundle; stack traces map back to the original sources. */
export async function importBundle(outfile: string): Promise<unknown> {
  process.setSourceMapsEnabled(true);
  return import(pathToFileURL(outfile).href);
}

/**
 * Resolves `@home-engine/sdk` to a virtual module re-exporting the installed SDK runtime
 * (`globalThis[Symbol.for("home-engine.sdk")]`).
 */
function sdkPlugin(): Plugin {
  return {
    name: "home-engine-sdk",
    setup(b) {
      b.onResolve({ filter: /^@home-engine\/sdk$/ }, () => ({
        path: "sdk",
        namespace: "home-engine-sdk",
      }));
      b.onLoad({ filter: /.*/, namespace: "home-engine-sdk" }, () => {
        const runtime = installedSdkRuntime();
        if (!runtime) throw new Error("The SDK runtime is not installed");
        const key = `Symbol.for(${JSON.stringify(SDK_RUNTIME_KEY.description)})`;
        const names = Object.keys(runtime).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
        const contents = [
          `const sdk = globalThis[${key}];`,
          ...names.map((n) => `export const ${n} = sdk.${n};`),
        ].join("\n");
        return { contents, loader: "js" };
      });
    },
  };
}

/**
 * Which rule files include which source files, from the bundles' metafiles. A change to any
 * source file (e.g. a helper module) rebuilds exactly the rule files that contain it.
 */
export class DependencyGraph {
  private readonly inputsByFile = new Map<string, Set<string>>();

  set(ruleFile: string, inputs: readonly string[]): void {
    this.inputsByFile.set(ruleFile, new Set(inputs.map((p) => resolve(p))));
  }

  delete(ruleFile: string): void {
    this.inputsByFile.delete(ruleFile);
  }

  /** Rule files whose bundle contains `sourcePath`. */
  dependents(sourcePath: string): string[] {
    const path = resolve(sourcePath);
    return [...this.inputsByFile]
      .filter(([, inputs]) => inputs.has(path))
      .map(([file]) => file)
      .sort();
  }
}
