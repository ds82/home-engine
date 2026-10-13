// Resolves relative links against the file they are written in and sends links that leave
// `docs/` to the repository (design decision 5).
//
// VitePress pastes included text (`<!--@include: ../README.md#quick-start-->`) into the page
// without recording where it came from, so a link in the README's quick start would be
// resolved against the page. Instead, a relative link is tried against the page's directory
// first and then against the directory of every file the page includes; the first base where
// the target exists wins. A target inside `docs/` stays a page link (rewritten relative to the
// page, so VitePress still checks it and turns `.md` into `.html`); a target outside becomes a
// link into the repository. A link that resolves nowhere is left as written, so VitePress
// reports it as dead.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MarkdownRenderer } from "vitepress";

export interface RepoLinkOptions {
  /** Absolute path of the repository root. */
  repoRoot: string;
  /** Absolute path of the documentation source directory (`docs/`). */
  docsDir: string;
  /** Repository URL, e.g. `https://github.com/ds82/home-engine`. */
  repository: string;
  /** Branch the repository links point to. */
  branch?: string;
}

const includeRE = /<!--\s*@include:\s*(.*?)\s*-->/g;

/** Directories of the files a page includes, in the order they appear. */
function includedDirs(page: string, docsDir: string): string[] {
  let source: string;
  try {
    source = readFileSync(page, "utf8");
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const match of source.matchAll(includeRE)) {
    // Strip a `#region` and a `{start,end}` line range, like VitePress does.
    const target = (match[1] ?? "").replace(/\{\d*,\d*\}$/, "").replace(/#[\w-]+$/, "");
    if (!target) {
      continue;
    }
    const file = target.startsWith("@")
      ? join(docsDir, target.slice(target[1] === "/" ? 2 : 1))
      : join(dirname(page), target);
    dirs.push(dirname(file));
  }
  return dirs;
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Rewrites one relative href of the page `page`, or returns undefined to keep it. */
export function resolveRepoLink(
  href: string,
  page: string,
  options: RepoLinkOptions,
): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) {
    return undefined;
  }
  const hashAt = href.indexOf("#");
  const path = decodeURI(hashAt >= 0 ? href.slice(0, hashAt) : href);
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  if (!path) {
    return undefined;
  }
  const pageDir = dirname(page);
  for (const base of [pageDir, ...includedDirs(page, options.docsDir)]) {
    const target = resolve(base, path);
    if (!existsSync(target)) {
      continue;
    }
    if (isInside(options.docsDir, target)) {
      if (base === pageDir) {
        return undefined;
      }
      const rel = relative(pageDir, target).split(sep).join("/");
      return (rel.startsWith(".") ? rel : `./${rel}`) + hash;
    }
    if (!isInside(options.repoRoot, target)) {
      return undefined;
    }
    const kind = statSync(target).isDirectory() ? "tree" : "blob";
    const repoPath = relative(options.repoRoot, target).split(sep).join("/");
    return `${options.repository}/${kind}/${options.branch ?? "main"}/${encodeURI(repoPath)}${hash}`;
  }
  return undefined;
}

/** markdown-it plugin that applies {@link resolveRepoLink} to every link of a page. */
export function repoLinks(md: MarkdownRenderer, options: RepoLinkOptions): void {
  md.core.ruler.push("repo_links", (state) => {
    const page = (state.env as { path?: string }).path;
    if (!page) {
      return;
    }
    for (const token of state.tokens) {
      for (const child of token.children ?? []) {
        if (child.type !== "link_open") {
          continue;
        }
        const href = child.attrGet("href");
        const rewritten = href === null ? undefined : resolveRepoLink(href, page, options);
        if (rewritten !== undefined) {
          child.attrSet("href", rewritten);
        }
      }
    }
  });
}
