# Design

## Context

See proposal.md for why. Today the documentation is:
- `README.md`, with a quick start, a table of the guides, the engine's configuration (environment variables) and its health and status endpoints;
- ten guides under `docs/`;
- TSDoc comments in `packages/sdk/src/*.ts`, exported through `packages/sdk/src/index.ts`, about 120 lines of exports. No export has a `@category` tag yet.

`scripts/check-docs.mjs` type-checks and lints every TypeScript sample in `README.md` and `docs/**/*.md`. `packages/engine/src/env-docs.test.ts` checks that the README's configuration table lists exactly the variables the config code reads. CI runs on Forgejo 16 (Forgejo Actions) with `node:24` containers. The existing jobs clone the repository by hand instead of using `actions/checkout`.

Once the project is ready, the repository moves to GitHub (`https://github.com/ds82/home-engine`), and the documentation site will most likely be published on GitHub Pages as a project site under `/home-engine/`.

**Naming:** prose says "documentation site". The glossary's **Site** is the backend's location context (time zone, coordinates, units), so a bare "site" is avoided in specs and docs.

## Goals / Non-Goals

**Goals:**
- One source for every text: guides stay in `docs/`, the reference comes from the SDK source, and the quick start lives in the README.
- Building the documentation site needs only `npm ci` and Node, no Docker and no SDK build.
- Moving the repository to GitHub changes one constant, not the guides.

**Non-Goals:**
- Deploying or hosting the documentation site, and a custom domain. A later change adds the GitHub Pages deploy.
- Versioned documentation (one site per release), and a version badge in the navigation. They can come later, when there are releases to keep apart; the SDK is at `0.0.0`.
- Reference pages for `@home-engine/engine` and `@home-engine/typegen`. Rule authors only use the SDK. The engine's configuration is covered by the configuration guide.
- Translations.

## Decisions

### 1. VitePress with `docs/` as its source directory

`docs/` becomes a private workspace `@home-engine/docs`:
- its `package.json` holds the documentation dependencies (`vitepress` `^1.6`; 2.0 is still alpha), so the engine and SDK packages stay unaffected;
- `docs/.vitepress/config.ts` holds the documentation site configuration;
- the existing guide files stay where they are.

VitePress turns `docs/rules/triggers.md` into `/rules/triggers.html` and rewrites relative `.md` links, so the same links work in the repository browser and on the documentation site.

*Alternatives:* Starlight (Astro) needs guides under `src/content/docs/`, which would move every file. TypeDoc's own HTML gives little control over guide navigation.

### 2. API reference: TypeDoc → Markdown → VitePress

TypeDoc (`0.28.x`, the range `typedoc-vitepress-theme` supports) with `typedoc-plugin-markdown` and `typedoc-vitepress-theme` renders the SDK into Markdown under `docs/api/`, together with a generated sidebar (`typedoc-sidebar.json`) that the VitePress config reads at startup (an empty sidebar when it does not exist yet, so typechecking the config needs no generated files). The configuration is `docs/typedoc.config.mjs`, a module rather than JSON, because it reads the repository URL from `docs/package.json` (Decision 4).
- **Input:** the entry point is `packages/sdk/src/index.ts`, with `packages/sdk/tsconfig.json`.
- **Grouping:** reference pages are grouped by TypeDoc categories. The SDK's doc comments get `@category` tags: Rules, Triggers, Scheduling, State, Service calls & writes, History, Storage, Logging, Types.
  - The category names follow the glossary: the functions in `writes.ts` (`on`, `off`, `call`, `setState`, …) are service calls and state writes, never "actions".
  - Placement follows the guides: `waitFor` and the state, bus, native and startup events go under Triggers; the time triggers, `sleep`, `after`, `randomInt`, the sun helpers, `TimeEvent` and `SunEvent` go under Scheduling.
  - TypeDoc runs with `categorizeByGroup: false`, a `categoryOrder` in the order above and `navigation.includeCategories`, so the sidebar and the index show categories instead of kinds. `kindSortOrder` lists functions and variables before interfaces and type aliases within a category.
  - Each trigger constructor's comment links to the event its runs receive (`onChange` → `StateEvent`).
- **Generated output:** `docs/api/` is git-ignored and regenerated before every `docs:build` and `docs:dev`, so it cannot drift.
- **Source links:** `sourceLinkTemplate` is `<repository>/blob/{gitRevision}/{path}#L{line}`, built from the repository URL (Decision 4), so "Defined in" links never point to the local `git remote`. They name the commit rather than `main`, so their line numbers stay correct.
- **Documentation gate:**
  - TypeDoc runs with `validation: { notDocumented: true, invalidLink: true }` and `treatValidationWarningsAsErrors: true`;
  - `requiredToBeDocumented` covers functions, interfaces, type aliases, variables and their properties, methods and accessors. Event and option fields such as those of `StateEvent` or `RuleOptions`, and methods such as `KeyValueStore.keys`, are exactly what rule authors look up.

  A missing comment fails the build and names the symbol.
- **`HassEntities` and `HassServices`:** these augmentable interfaces get a doc comment that points to the typings guide, because their members come from the user's generated file.
- **Types the SDK does not export:** TypeDoc's `notExported` validation would fail on three of them. `IsEmpty`, a type-level helper, is listed in `intentionallyNotExported`. `LogFunction` (the logger's methods) and `CommonRuleOptions` (the fields shared by `RuleOptions` and `SetupOptions`) get `@inline`, so their signatures and fields appear where they are used. The SDK's API does not change.

*Alternative:* TypeDoc HTML as a separate site under `/api/`. Rejected because search and navigation would be split in two.

### 3. Pages from the README

- **Quick start:** the documentation site's `docs/getting-started.md` includes the README's quick start through VitePress's `<!--@include: ../README.md#quick-start-->`, using a `#region quick-start` marker in the README. The README stays the first thing people see on the forge, and the text exists once. Its relative links stay as they are; Decision 5 resolves them.
- **Configuration and status:** the README's "Configuration" and "Health and status" sections move into `docs/configuration.md` and `docs/status.md`, unchanged in content. The README keeps a short pointer to each and adds them to its docs table. `env-docs.test.ts` reads the variable table from `docs/configuration.md`.
- **Home page:** `docs/index.md` uses VitePress's home layout with a short pitch, three feature blurbs and buttons to "Getting started" and "API reference".

*Alternative for configuration:* a second README include. Rejected because the README is already long and the sections are reference material that belongs next to the guides.

### 4. Base path, repository URL and site settings

- **Base path:** `base` comes from the environment variable `DOCS_BASE` (default `/`). For the GitHub Pages project site it will be `/home-engine/`.
- **Repository URL:** the `repository` field of `docs/package.json`, `https://github.com/ds82/home-engine`. The VitePress config and the TypeDoc config both read it, so it is set in one place. Edit links, links that leave `docs/` and TypeDoc source links are built from it. Nothing is published before the move to GitHub, so the documentation site can point there already.
- **Clean URLs:** `cleanUrls` stays off, because plain static hosts like GitHub Pages serve `.html` files without rewrite rules.
- **Search:** local search uses VitePress's built-in MiniSearch, with no external service.
- **Edit links:** `<repository>/edit/main/docs/:path`. The generated `api/` pages get none (set through `transformPageData`), because their source is the SDK, not a file under `docs/`.

### 5. Links

- **Pages:** VitePress fails the build on dead links to pages by default; `ignoreDeadLinks` stays off.
- **Links that leave `docs/`:** a small markdown-it hook (`docs/.vitepress/repo-links.ts`) resolves every relative link against the file it is written in. VitePress pastes included text into the page without recording its origin, and renders the search index without its list of included files. So the hook reads the page's own `@include` directives, tries the link against the page's directory first and then against the directory of each included file, and uses the first base where the target exists.
  - A target inside `docs/` stays a page link, rewritten relative to the page, so VitePress still checks it and turns `.md` into `.html`.
  - A target outside `docs/` becomes `<repository>/blob/main/<path>` for a file or `<repository>/tree/main/<path>` for a directory.
  - A link that resolves nowhere is left as written, so VitePress reports it as dead.

  In the quick start, `docs/rules/typings.md` becomes the typings page and `examples/rules` becomes a repository link.
- **Anchors:** VitePress does not check heading anchors, so `scripts/check-docs-links.mjs` runs after the build. It walks the built HTML, collects the `id`s on every page and verifies every internal `href` with a fragment. A broken anchor fails with the source page and the target. The script has no dependencies beyond Node.

### 6. Scripts and existing checks

- **Root scripts:**
  - `docs:api` (TypeDoc);
  - `docs:dev` (`docs:api`, then `vitepress dev docs`);
  - `docs:build` (`docs:api`, then `vitepress build docs`, then `node scripts/check-docs-links.mjs`).
- **Workspace scripts:** the docs workspace has no `build` script, so the root `npm run build --workspaces` does not build the documentation site in the `check` job. It has a `typecheck` script, which the root `typecheck` picks up; its `tsconfig.json` covers `.vitepress/`, `test/` and its vitest config.
- **Tests:** the root `vitest.config.ts` adds a `docs` project, whose tests in `docs/test/` cover the link hook and the anchor check.
- **`scripts/check-docs.mjs`:** it skips `docs/api/`, `docs/.vitepress/` and `docs/node_modules/`. The guides' TypeScript samples are still type-checked and linted as before.
- **Lint and format:**
  - ESLint already ignores `**/dist/**`, which covers the VitePress build output, and additionally ignores `docs/.vitepress/cache/`;
  - Prettier ignores the generated `docs/api/` and the build output `docs/.vitepress/dist/` and `docs/.vitepress/cache/`.

### 7. CI job

A new `docs` job in `.forgejo/workflows/ci.yml`:
- runs in a `node:24` container;
- clones the repository the same way the existing jobs do;
- runs `npm ci` and `npm run docs:build`;
- uploads `docs/.vitepress/dist` with `actions/upload-artifact@v3` as artifact `docs-site`. v4 fails on Forgejo 16 with `GHESNotSupportedError`, because it only supports github.com; after the move to GitHub the job can use v4.

The job runs alongside `check` and is independent of the Docker jobs. When the repository moves to GitHub, it ports to `.github/workflows` almost unchanged, and the Pages deploy builds on it.

## Risks / Trade-offs

- **[The documentation gate blocks unrelated work]** Any new SDK export or property without a comment fails CI. → That is the intent, and the error names the symbol. Internal helpers are not exported from `index.ts`, so they are unaffected.
- **[Generated Markdown breaks VitePress]** TypeDoc output can contain `{{ }}` or `<` that Vue interprets. → `typedoc-vitepress-theme` escapes these. The first build task checks the full SDK, and any symbol that still breaks is fixed in its comment.
- **[Dependency weight]** VitePress brings Vue, Vite and esbuild into the lockfile. → They are confined to the private `docs` workspace and never reach the published packages or the container image (the Dockerfile copies only `packages/*`).
- **[Overloaded functions]** Functions like `forceOn` have several overload signatures. TypeDoc expects a comment on each signature or on the implementation. → Comments are added per signature where the overloads differ, otherwise on the first.
- **[Link resolved against the wrong base]** If a relative link's target exists both next to the page and next to an included file, the page wins. → Included README text uses root-relative paths (`examples/…`, `docs/…`), so the two rarely collide, and a wrong target still has to exist.
- **[Repository links point to GitHub before the move]** Edit and source links lead to a repository that does not exist yet. → The documentation site is not published before the move; until then the links only appear in local builds and CI artifacts.

## Migration Plan

This is additive, apart from moving two README sections into guides. Contributors run `npm ci` once to install the docs workspace. Rollback is a revert. Publishing later only needs a deploy step that copies `docs/.vitepress/dist` to GitHub Pages, built with `DOCS_BASE=/home-engine/`.
