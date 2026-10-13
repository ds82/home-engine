import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type DefaultTheme } from "vitepress";
import { repoLinks } from "./repo-links.js";

const docsDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The canonical repository, from the `repository` field of docs/package.json, which TypeDoc
 * also reads for its source links. Edit links and links to files outside `docs/` point here.
 */
const repository: string = JSON.parse(readFileSync(`${docsDir}/package.json`, "utf8")).repository
  .url;

/** The API reference sidebar that `npm run docs:api` generates; empty before the first run. */
const apiSidebarFile = `${docsDir}/api/typedoc-sidebar.json`;
const apiSidebar: DefaultTheme.SidebarItem[] = existsSync(apiSidebarFile)
  ? JSON.parse(readFileSync(apiSidebarFile, "utf8"))
  : [];

export default defineConfig({
  title: "home-engine",
  description: "Home Assistant automations as TypeScript rules",
  // Set DOCS_BASE when the site is served from a sub-path, e.g. /home-engine/ on GitHub Pages.
  base: process.env["DOCS_BASE"] || "/",
  // Plain static hosts serve `.html` files without rewrite rules.
  cleanUrls: false,
  lastUpdated: false,
  // The reference pages are generated from the SDK source, so there is nothing to edit there.
  transformPageData(pageData) {
    if (pageData.relativePath.startsWith("api/")) {
      pageData.frontmatter["editLink"] = false;
    }
  },
  markdown: {
    config: (md) => repoLinks(md, { repoRoot, docsDir, repository }),
  },
  themeConfig: {
    nav: [
      { text: "Getting started", link: "/getting-started" },
      { text: "Guides", link: "/rules/files" },
      { text: "API reference", link: "/api/" },
    ],
    sidebar: {
      "/api/": [{ text: "API reference", link: "/api/", items: apiSidebar }],
      "/": [
        {
          text: "Introduction",
          items: [{ text: "Getting started", link: "/getting-started" }],
        },
        {
          text: "Writing rules",
          items: [
            { text: "Rule files", link: "/rules/files" },
            { text: "Triggers", link: "/rules/triggers" },
            { text: "Scheduling", link: "/rules/scheduling" },
            { text: "Reading state and acting", link: "/rules/actions" },
            { text: "History", link: "/rules/history" },
            { text: "Storage", link: "/rules/storage" },
            { text: "Typings", link: "/rules/typings" },
          ],
        },
        {
          text: "Running the engine",
          items: [
            { text: "Configuration", link: "/configuration" },
            { text: "Health and status", link: "/status" },
          ],
        },
        {
          text: "Migrating",
          items: [
            { text: "Coming from openHAB", link: "/migrating-from-openhab" },
            { text: "Coming from AppDaemon", link: "/migrating-from-appdaemon" },
          ],
        },
        {
          text: "More",
          items: [{ text: "Performance", link: "/performance" }],
        },
      ],
    },
    search: { provider: "local" },
    editLink: {
      pattern: `${repository}/edit/main/docs/:path`,
      text: "Edit this page",
    },
    socialLinks: [{ icon: "github", link: repository }],
    outline: [2, 3],
  },
});
