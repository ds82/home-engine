#!/usr/bin/env node
// Type-checks the TypeScript samples in the documentation against the SDK types.
//
// Every ```ts / ```typescript block in README.md and docs/**/*.md is compiled as its own
// module, with `@home-engine/sdk` resolved to packages/sdk/src. Errors are reported as
// `file.md:line:column`. Mark a block that is intentionally incomplete with `ts nocheck`
// (```ts nocheck) to skip it.
//
// Usage: node scripts/check-docs.mjs [--root <dir>]   (default root: the repository)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkEntry = join(repo, "packages/sdk/src/index.ts");

function parseArgs(argv) {
  const i = argv.indexOf("--root");
  return { root: i >= 0 ? resolve(argv[i + 1]) : repo };
}

function markdownFiles(root) {
  const files = [];
  const readme = join(root, "README.md");
  if (existsSync(readme)) files.push(readme);
  const docs = join(root, "docs");
  if (existsSync(docs)) {
    for (const entry of readdirSync(docs, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(join(entry.parentPath, entry.name));
      }
    }
  }
  return files.sort();
}

/** Code blocks with their language and the 1-based line of their first code line. */
function extractBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  let open;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(\S*)\s*(.*)$/.exec(line);
    if (!open && fence) {
      open = { lang: fence[1], info: fence[2], startLine: i + 2, code: [] };
    } else if (open && /^\s*```\s*$/.test(line)) {
      blocks.push({ ...open, code: open.code.join("\n") });
      open = undefined;
    } else if (open) {
      open.code.push(line);
    }
  }
  return blocks.filter(
    (b) => (b.lang === "ts" || b.lang === "typescript") && !/\bnocheck\b/.test(b.info),
  );
}

export function checkDocs(root) {
  const sources = new Map(); // virtual file name → { md, startLine, code }
  for (const md of markdownFiles(root)) {
    extractBlocks(readFileSync(md, "utf8")).forEach((block, n) => {
      const name = join(
        repo,
        ".docs-check",
        `${relative(root, md).replace(/[\\/]/g, "__")}.${n}.ts`,
      );
      sources.set(name, { md: relative(root, md), startLine: block.startLine, code: block.code });
    });
  }

  const options = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
    lib: ["lib.es2023.d.ts"],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    types: ["node"],
    typeRoots: [join(repo, "node_modules/@types")],
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    paths: { "@home-engine/sdk": [sdkEntry] },
    baseUrl: repo,
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (f) => sources.get(resolve(f))?.code ?? readFile(f);
  host.fileExists = (f) => sources.has(resolve(f)) || fileExists(f);
  const program = ts.createProgram([...sources.keys()], options, host);

  const problems = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const file = diagnostic.file && sources.get(resolve(diagnostic.file.fileName));
    if (file && diagnostic.start !== undefined) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      problems.push(
        `${file.md}:${file.startLine + line}:${character + 1} - error TS${diagnostic.code}: ${message}`,
      );
    } else {
      problems.push(`error TS${diagnostic.code}: ${message}`);
    }
  }
  return { blocks: sources.size, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { root } = parseArgs(process.argv.slice(2));
  const { blocks, problems } = checkDocs(root);
  for (const p of problems) console.error(p);
  console.log(`docs check: ${blocks} TypeScript block(s), ${problems.length} error(s)`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
