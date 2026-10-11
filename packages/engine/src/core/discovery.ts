// Finding rule files in the rules directory (rule-files: Rule directory discovery).
// Every .ts/.mts/.js/.mjs file is a rule file, except anything in node_modules, files or
// directories whose name starts with `_` or `.` (helper modules, hidden files), type
// declarations and test files. Files whose rule IDs would collide (hallway.ts next to
// hallway.js) are reported and none of them is loaded.

import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Logger } from "./logger.js";
import { fileIdBase } from "./registration.js";

const RULE_EXTENSIONS = /\.(ts|mts|js|mjs)$/;
const EXCLUDED_FILE = /(\.d\.(ts|mts)|\.(test|spec)\.[cm]?[jt]s)$/;

/** True for a rule file path relative to the rules directory (with `/` or the OS separator). */
export function isRuleFile(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  const name = parts.at(-1) ?? "";
  if (parts.some((p) => p === "node_modules" || p.startsWith("_") || p.startsWith("."))) {
    return false;
  }
  return RULE_EXTENSIONS.test(name) && !EXCLUDED_FILE.test(name);
}

export interface IdConflict {
  /** The rule ID prefix the files share, e.g. `lights/hallway`. */
  idBase: string;
  files: string[];
}

export interface DiscoveryResult {
  /** Rule files to load, relative to the rules directory with `/` separators, sorted. */
  files: string[];
  /** Files left out because their rule IDs would collide. */
  conflicts: IdConflict[];
}

export async function discoverRuleFiles(rulesDir: string): Promise<DiscoveryResult> {
  const candidates: string[] = [];
  await walk(rulesDir, rulesDir, candidates);

  const byIdBase = new Map<string, string[]>();
  for (const file of candidates) {
    const base = fileIdBase(file);
    byIdBase.set(base, [...(byIdBase.get(base) ?? []), file]);
  }

  const files: string[] = [];
  const conflicts: IdConflict[] = [];
  for (const [idBase, group] of byIdBase) {
    if (group.length === 1) files.push(...group);
    else conflicts.push({ idBase, files: group.sort() });
  }
  conflicts.sort((a, b) => a.idBase.localeCompare(b.idBase));
  return { files: files.sort(), conflicts };
}

/** Logs what discovery found: conflicts as errors, an empty directory as a warning. */
export function reportDiscovery(log: Logger, rulesDir: string, result: DiscoveryResult): void {
  for (const conflict of result.conflicts) {
    log.error(
      { files: conflict.files },
      `Rule files ${conflict.files.join(" and ")} would get the same rule IDs (${conflict.idBase}#…); loading neither`,
    );
  }
  if (result.files.length === 0 && result.conflicts.length === 0) {
    log.warn({ rulesDir }, `No rule files found in ${rulesDir}; watching for new files`);
  } else {
    log.info({ files: result.files.length }, `Found ${result.files.length} rule file(s)`);
  }
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || /^[_.]/.test(entry.name)) continue;
      await walk(root, path, out);
    } else if (entry.isFile() && isRuleFile(rel)) {
      out.push(rel);
    }
  }
}
