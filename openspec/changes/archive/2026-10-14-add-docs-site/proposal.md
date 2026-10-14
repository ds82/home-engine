# Proposal

## Why

The rule-writing documentation exists only as Markdown files in the repository (`docs/`, linked from the README), and the SDK's API is documented only in TSDoc comments that users see in their editor. The engine's configuration and its status endpoints are described only in the README. There is no single place to browse the guides together with a complete reference of `@home-engine/sdk`. A static documentation site fixes that. Once the project is ready, the repository moves to GitHub and the documentation site will most likely be published on GitHub Pages, but any static web server can host it.

## What Changes

- A documentation site, built with VitePress from the existing guides in `docs/`. It gets a home page, a getting-started page with the README's quick start, navigation, a sidebar and local full-text search.
- The README's "Configuration" and "Health and status" sections move into guides (`docs/configuration.md`, `docs/status.md`), so the documentation site covers them. The README links to them.
- An API reference for `@home-engine/sdk`, generated with TypeDoc from the SDK's TSDoc comments into the same documentation site. It covers every public export and its properties.
- Links that leave `docs/` (to the README's examples, to source files) point to the canonical repository on GitHub, configured in one place.
- Quality gates:
  - a build fails on broken internal links and anchors;
  - the reference build fails when a public export or one of its properties has no documentation comment.
- `npm run docs:build` produces a static site with a configurable base path, for hosting under a sub-path such as `/home-engine/`. `npm run docs:dev` serves it locally with live reload.
- A CI job builds the documentation site on every push and keeps the output as a downloadable artifact.
- The guides stay plain Markdown that reads correctly in the repository browser. The README keeps its docs table.
- **Not in scope:** deploying the documentation site. Forgejo has no built-in Pages service; the deploy step (most likely to GitHub Pages after the move to GitHub) comes in a later change.

## Capabilities

### New Capabilities

- `docs-site`: the published documentation, covering how it is built from the guides and the SDK's doc comments, what it must contain, and the checks a build must pass. ("Documentation site" in prose; a bare "Site" is the glossary term for the backend's location context.)

### Modified Capabilities

None. The behaviour of the engine and the SDK does not change.

## Impact

- **New workspace `docs/`** (private package `@home-engine/docs`): VitePress config in `docs/.vitepress/`, the TypeDoc config `docs/typedoc.config.mjs`, new pages `docs/index.md` and `docs/getting-started.md`, and dev dependencies on `vitepress`, `typedoc`, `typedoc-plugin-markdown` and `typedoc-vitepress-theme`. The `repository` field of `docs/package.json` is the single source of the repository URL.
- **README:** a `#region quick-start` marker around the quick start; the "Configuration" and "Health and status" sections move to `docs/configuration.md` and `docs/status.md`. `packages/engine/src/env-docs.test.ts` reads the configuration table from its new place.
- **SDK:** missing or thin doc comments on public exports and their properties are filled in, and exports get `@category` tags, so the reference build passes. There are no API changes.
- **Scripts:** `docs:api`, `docs:build` and `docs:dev` in the root `package.json`; a new `scripts/check-docs-links.mjs`; `scripts/check-docs.mjs` skips the generated reference pages.
- **Tests:** a `docs` vitest project (`docs/test/`) covers the link hook and the anchor check.
- **Lint and format:** ESLint and Prettier ignore the generated reference and the VitePress build output and cache.
- **CI:** a new `docs` job in `.forgejo/workflows/ci.yml`.
- **Repository:** the generated reference and the build output are git-ignored.
