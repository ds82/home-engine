#!/usr/bin/env node
// Checks the heading anchors of the built documentation site.
//
// VitePress fails the build on links to missing pages, but not on links to missing anchors
// (`triggers.md#missing-heading`). This script walks the built HTML, collects the element IDs
// of every page and verifies every internal link with a fragment against its target page.
// Broken anchors are reported as `source page → target`, and the script exits with 1.
//
// Usage: node scripts/check-docs-links.mjs [--dist <dir>]   (default: docs/.vitepress/dist)
// The base path comes from DOCS_BASE, like in the VitePress config.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const i = argv.indexOf("--dist");
  return { dist: i >= 0 ? resolve(argv[i + 1]) : join(repo, "docs/.vitepress/dist") };
}

function htmlPages(dist) {
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

function decodeEntities(text) {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The page markup without inline scripts, which hold data rather than links. */
function markup(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function ids(html) {
  return new Set([...markup(html).matchAll(/\sid="([^"]*)"/g)].map((m) => decodeEntities(m[1])));
}

function hrefs(html) {
  return [...markup(html).matchAll(/\shref="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
}

/**
 * The page (path relative to dist) and fragment an internal link points to, or undefined for
 * links without a fragment and links outside the documentation site.
 */
function resolveLink(href, page, base) {
  const hashAt = href.indexOf("#");
  if (hashAt < 0 || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
    return undefined;
  }
  const path = href.slice(0, hashAt);
  const fragment = decodeURIComponent(href.slice(hashAt + 1));
  let target;
  if (path === "") {
    target = page;
  } else if (path.startsWith("/")) {
    if (!path.startsWith(base)) {
      return undefined;
    }
    target = path.slice(base.length);
  } else {
    target = posix.normalize(posix.join(posix.dirname(page), path));
  }
  if (target === "" || target.endsWith("/")) {
    target += "index.html";
  }
  return { target, fragment };
}

function main() {
  const { dist } = parseArgs(process.argv.slice(2));
  if (!existsSync(dist)) {
    console.error(`docs links: ${dist} does not exist; run the VitePress build first`);
    process.exit(2);
  }
  const rawBase = process.env.DOCS_BASE || "/";
  const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
  const pages = new Map(
    htmlPages(dist).map((page) => [page, readFileSync(join(dist, page), "utf8")]),
  );
  const pageIds = new Map([...pages].map(([page, html]) => [page, ids(html)]));

  const broken = [];
  let checked = 0;
  for (const [page, html] of pages) {
    for (const href of new Set(hrefs(html))) {
      const link = resolveLink(href, page, base);
      if (!link || link.fragment === "") {
        continue;
      }
      checked++;
      const targetIds = pageIds.get(link.target);
      if (!targetIds) {
        broken.push(`${page} → ${href} (no page ${link.target})`);
      } else if (!targetIds.has(link.fragment)) {
        broken.push(`${page} → ${href} (no anchor #${link.fragment} on ${link.target})`);
      }
    }
  }

  for (const line of broken) {
    console.error(`broken link: ${line}`);
  }
  console.log(
    `docs links: ${checked} anchor link(s) on ${pages.size} page(s), ${broken.length} broken`,
  );
  process.exit(broken.length > 0 ? 1 : 0);
}

main();
