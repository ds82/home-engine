# Design

## Context

See proposal.md for why. Today the documentation is:
- `README.md`, with a quick start and a table of the guides;
- ten guides under `docs/`;
- TSDoc comments in `packages/sdk/src/*.ts`, exported through `packages/sdk/src/index.ts`, about 120 lines of exports.

`scripts/check-docs.mjs` type-checks and lints every TypeScript sample in `README.md` and `docs/**/*.md`. CI runs on Forgejo 16 (Forgejo Actions) with `node:24` containers. The existing jobs clone the repository by hand instead of using `actions/checkout`.

## Goals / Non-Goals

**Goals:**
- One source for every text: guides stay in `docs/`, the reference comes from the SDK source, and the quick start lives in the README.
- Building the site needs only `npm ci` and Node, no Docker and no SDK build.

**Non-Goals:**
- Deploying or hosting the site, and a custom domain.
- Versioned documentation (one site per release). It can come later, when there are releases to keep apart.
- Reference pages for `@home-engine/engine` and `@home-engine/typegen`. Rule authors only use the SDK. The engine's configuration is covered by the guides.
- Translations.

## Decisions

### 1. VitePress with `docs/` as its source directory

`docs/` becomes a private workspace `@home-engine/docs`:
- its `package.json` holds the documentation dependencies, so the engine and SDK packages stay unaffected;
- `docs/.vitepress/config.ts` holds the site configuration;
- the existing guide files stay where they are.

VitePress turns `docs/rules/triggers.md` into `/rules/triggers.html` and rewrites relative `.md` links, so the same links work in the repository browser and on the site.

*Alternatives:* Starlight (Astro) needs guides under `src/content/docs/`, which would move every file. TypeDoc's own HTML gives little control over guide navigation.

### 2. API reference: TypeDoc → Markdown → VitePress

TypeDoc with `typedoc-plugin-markdown` and `typedoc-vitepress-theme` renders the SDK into Markdown under `docs/api/`, together with a generated sidebar (`typedoc-sidebar.json`) that the VitePress config imports.
- **Input:** the entry point is `packages/sdk/src/index.ts`, with `packages/sdk/tsconfig.json`.
- **Grouping:** reference pages are grouped by TypeDoc categories. The SDK's doc comments get `@category` tags: Rules, Triggers, Scheduling, State, Actions, History, Storage, Logging, Types.
- **Generated output:** `docs/api/` is git-ignored and regenerated before every `docs:build` and `docs:dev`, so it cannot drift.
- **Documentation gate:**
  - TypeDoc runs with `validation: { notDocumented: true, invalidLink: true }` and `treatValidationWarningsAsErrors: true`;
  - `requiredToBeDocumented` covers functions, interfaces, type aliases, variables and their properties.

  A missing comment fails the build and names the symbol.
- **`HassEntities` and `HassServices`:** these augmentable interfaces get a doc comment that points to the typings guide, because their members come from the user's generated file.

*Alternative:* TypeDoc HTML as a separate site under `/api/`. Rejected because search and navigation would be split in two.

### 3. Quick start from the README via an include

The site's `docs/getting-started.md` includes the README's quick start through VitePress's `<!--@include: ../README.md#quick-start-->`, using a `#region quick-start` marker in the README. The README stays the first thing people see on the forge, and the text exists once. The included region must not contain relative links, because they would resolve against `docs/`. The link check (Decision 5) catches any that remain.

The home page `docs/index.md` uses VitePress's home layout with a short pitch, three feature blurbs and buttons to "Getting started" and "API reference".

### 4. Base path, version and site settings

- **Base path:** `base` comes from the environment variable `DOCS_BASE` (default `/`). For a GitHub Pages project site it would be `/home-engine/`.
- **Version:** the navigation shows the SDK version read from `packages/sdk/package.json`.
- **Clean URLs:** `cleanUrls` stays off, because plain static hosts like GitHub Pages serve `.html` files without rewrite rules.
- **Search:** local search uses VitePress's built-in MiniSearch, with no external service.
- **Edit links:** these point to the Forgejo repository, configured in one place in `docs/.vitepress/config.ts`.

### 5. Link checking

- **Pages:** VitePress fails the build on dead links to pages by default; `ignoreDeadLinks` stays off.
- **Anchors:** VitePress does not check heading anchors, so `scripts/check-site-links.mjs` runs after the build. It walks the built HTML, collects the `id`s on every page and verifies every internal `href` with a fragment. A broken anchor fails with the source page and the target. The script has no dependencies beyond Node.
- **Links outside the site:** links from guides to files outside `docs/` (for example `../examples/`) are written as absolute repository URLs, because the site cannot serve those files.

### 6. Scripts and existing checks

- **Root scripts:**
  - `docs:api` (TypeDoc);
  - `docs:dev` (`docs:api`, then `vitepress dev docs`);
  - `docs:build` (`docs:api`, then `vitepress build docs`, then the anchor check).
- **`scripts/check-docs.mjs`:** it skips `docs/api/`, `docs/.vitepress/` and `docs/node_modules/`. The guides' TypeScript samples are still type-checked and linted as before.
- **Formatting:** Prettier ignores the generated `docs/api/` and the build output `docs/.vitepress/dist/` and `docs/.vitepress/cache/`.

### 7. CI job

A new `docs` job in `.forgejo/workflows/ci.yml`:
- runs in a `node:24` container;
- clones the repository the same way the existing jobs do;
- runs `npm ci` and `npm run docs:build`;
- uploads `docs/.vitepress/dist` with `actions/upload-artifact@v4` as artifact `docs-site`. Forgejo 16 supports the v4 artifact protocol; if the runner cannot resolve the action, fall back to `@v3`.

The job runs alongside `check` and is independent of the Docker jobs.

## Risks / Trade-offs

- **[The documentation gate blocks unrelated work]** Any new SDK export without a comment fails CI. → That is the intent, and the error names the symbol. Internal helpers are not exported from `index.ts`, so they are unaffected.
- **[Generated Markdown breaks VitePress]** TypeDoc output can contain `{{ }}` or `<` that Vue interprets. → `typedoc-vitepress-theme` escapes these. The first build task checks the full SDK, and any symbol that still breaks is fixed in its comment.
- **[Dependency weight]** VitePress brings Vue, Vite and esbuild into the lockfile. → They are confined to the private `docs` workspace and never reach the published packages or the container image (the Dockerfile copies only `packages/*`).
- **[Overloaded functions]** Functions like `forceOn` have several overload signatures. TypeDoc expects a comment on each signature or on the implementation. → Comments are added per signature where the overloads differ, otherwise on the first.

## Migration Plan

This is additive. Contributors run `npm ci` once to install the docs workspace. Rollback is a revert. Publishing later only needs a deploy step that copies `docs/.vitepress/dist` to the chosen host, built with the matching `DOCS_BASE`.
