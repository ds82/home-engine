# Proposal

## Why

The rule-writing documentation exists only as Markdown files in the repository (`docs/`, linked from the README), and the SDK's API is documented only in TSDoc comments that users see in their editor. There is no single place to browse the guides together with a complete reference of `@home-engine/sdk`. A static documentation site fixes that, and it can be hosted anywhere (GitHub Pages, Codeberg Pages, any web server) once the project decides where to publish.

## What Changes

- A documentation site, built with VitePress from the existing guides in `docs/`. It gets a home page, navigation, a sidebar and local full-text search.
- An API reference for `@home-engine/sdk`, generated with TypeDoc from the SDK's TSDoc comments into the same site. It covers every public export.
- Quality gates:
  - a build fails on broken internal links;
  - the reference build fails when a public export has no documentation comment.
- `npm run docs:build` produces a static site with a configurable base path, for hosting under a sub-path such as `/home-engine/`. `npm run docs:dev` serves it locally with live reload.
- A CI job builds the site on every push and keeps the output as a downloadable artifact.
- The guides stay plain Markdown that reads correctly in the repository browser. The README keeps its docs table.
- **Not in scope:** deploying the site. Forgejo has no built-in Pages service, and the hosting decision is open. A later change adds the deploy step.

## Capabilities

### New Capabilities

- `docs-site`: the published documentation, covering how it is built from the guides and the SDK's doc comments, what it must contain, and the checks a build must pass.

### Modified Capabilities

None. The behaviour of the engine and the SDK does not change.

## Impact

- **New workspace `docs/`** (private package `@home-engine/docs`): VitePress config in `docs/.vitepress/`, a new `docs/index.md` home page, and dev dependencies on `vitepress`, `typedoc`, `typedoc-plugin-markdown` and `typedoc-vitepress-theme`.
- **SDK:** missing or thin doc comments on public exports are filled in so the reference build passes. There are no API changes.
- **Scripts:** `docs:build` and `docs:dev` in the root `package.json`. `scripts/check-docs.mjs` skips the generated reference pages.
- **CI:** a new `docs` job in `.forgejo/workflows/ci.yml`.
- **Repository:** the generated reference and the build output are git-ignored.
