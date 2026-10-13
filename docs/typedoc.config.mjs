// TypeDoc renders the SDK's API reference as Markdown into docs/api/ (design decision 2).
// The generated pages and their sidebar (api/typedoc-sidebar.json) are git-ignored and rebuilt
// by `npm run docs:api` before every `docs:dev` and `docs:build`.

import { readFileSync } from "node:fs";

const { repository } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));

/** @type {Partial<import("typedoc").TypeDocOptions & import("typedoc-plugin-markdown").PluginOptions>} */
export default {
  entryPoints: ["../packages/sdk/src/index.ts"],
  tsconfig: "../packages/sdk/tsconfig.json",
  plugin: ["typedoc-plugin-markdown", "typedoc-vitepress-theme"],
  out: "api",
  docsRoot: ".",
  readme: "none",
  name: "@home-engine/sdk",
  sourceLinkTemplate: `${repository.url}/blob/{gitRevision}/{path}#L{line}`,
  // Group the reference by the SDK's `@category` tags (Rules, Triggers, …), not by kind.
  categorizeByGroup: false,
  categoryOrder: [
    "Rules",
    "Triggers",
    "Scheduling",
    "State",
    "Service calls & writes",
    "History",
    "Storage",
    "Logging",
    "Types",
    "*",
  ],
  navigation: { includeCategories: true, includeGroups: false },
  // Within a category, what rule code calls comes before the types it uses.
  kindSortOrder: ["Function", "Variable", "Interface", "TypeAlias"],
  excludePrivate: true,
  excludeInternal: true,
  // Type-level helpers the SDK does not export; the types using them are documented instead.
  intentionallyNotExported: ["IsEmpty"],
  // The documentation gate: every export and every property needs a comment, and `{@link}`s
  // must resolve. Any warning fails the build and names the symbol.
  validation: { notExported: true, notDocumented: true, invalidLink: true },
  requiredToBeDocumented: [
    "Function",
    "Interface",
    "TypeAlias",
    "Variable",
    "Property",
    "Method",
    "Accessor",
  ],
  treatValidationWarningsAsErrors: true,
};
