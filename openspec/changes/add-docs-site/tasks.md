# Tasks

## 1. Documentation site skeleton

- [x] 1.1 Create the private workspace `docs/` (`@home-engine/docs`) with `vitepress` `^1.6` as a dev dependency and a `typecheck` script for `.vitepress/config.ts`, but no `build` script. Add it to the root `workspaces`, add root scripts `docs:dev` and `docs:build`, git-ignore and Prettier-ignore `docs/.vitepress/dist`, `docs/.vitepress/cache` and `docs/api`, and add `docs/.vitepress/cache` to the ESLint ignores. Verify `npm ci` succeeds, `npm run docs:build` builds the existing guides, and `npm run build`, `npm run lint` and `npm run typecheck` pass without building the documentation site.
- [x] 1.2 Write `docs/.vitepress/config.ts` (design decisions 1 and 4):
  - title;
  - base path from `DOCS_BASE`;
  - the repository URL from the `repository` field of `docs/package.json` (`https://github.com/ds82/home-engine`);
  - navigation without a version badge;
  - a sidebar grouping the rule guides, configuration and status, migration guides and performance;
  - local search;
  - edit links built from the repository URL;
  - `cleanUrls: false`.

  Verify that a build with `DOCS_BASE=/home-engine/`, served from a sub-directory by `npx serve`, loads every page and asset.
- [x] 1.3 Make `scripts/check-docs.mjs` skip `docs/api/`, `docs/.vitepress/` and `docs/node_modules/`. Verify `npm run docs:check` still reports the same number of samples from the guides.

## 2. Pages from the README

- [x] 2.1 Move the README's "Configuration" and "Health and status" sections into `docs/configuration.md` and `docs/status.md`. Leave a short pointer to each in the README and add both to its docs table. Point `packages/engine/src/env-docs.test.ts` at `docs/configuration.md`. Verify the engine tests pass and the README reads correctly on Forgejo.
- [x] 2.2 Add a `#region quick-start` marker around the README's quick start, and create `docs/getting-started.md`, which includes it (design decision 3). Verify the page renders the quick start.
- [x] 2.3 Add the markdown-it hook that resolves relative links against the file they are written in and turns targets outside `docs/` into `<repository>/blob/main/<path>` (design decision 5). Verify that on the getting-started page `examples/docker-compose.yml` links to the repository, `docs/rules/typings.md` links to the typings page, and `npm run docs:build` reports no dead links.
- [x] 2.4 Write `docs/index.md` with the home layout: a short pitch, three feature blurbs, and buttons to "Getting started" and "API reference". Verify the built home page links resolve.

## 3. SDK API reference

- [x] 3.1 Add `typedoc` (`0.28.x`), `typedoc-plugin-markdown` and `typedoc-vitepress-theme` to the docs workspace, with a `docs/typedoc.config.mjs` for `packages/sdk/src/index.ts`, output to `docs/api/`, a `sourceLinkTemplate` built from the repository URL that names the commit, and the generated sidebar included in the VitePress config. Add the root script `docs:api` and run it before `docs:dev` and `docs:build`. Verify the reference pages build, `onChange` shows its signature and links to `StateEvent`, and "Defined in" links point to GitHub.
- [x] 3.2 Enable `validation.notDocumented` and `invalidLink` with `treatValidationWarningsAsErrors`, and `requiredToBeDocumented` including properties, methods and accessors. Then add or complete the doc comments the build reports, including the overload signatures, the properties of the exported interfaces, `HassEntities` and `HassServices`. Verify `npm run docs:api` passes, and fails naming the symbol when a comment is removed from one export and from one property.
- [x] 3.3 Add `@category` tags to the SDK's exports (Rules, Triggers, Scheduling, State, Service calls & writes, History, Storage, Logging, Types) so the reference sidebar is grouped. Verify that the sidebar shows those groups and the SDK's lint, typecheck and tests still pass.

## 4. Link and search checks

- [x] 4.1 Write `scripts/check-docs-links.mjs`, which checks every internal link with a fragment in the built HTML against the target page's element IDs and runs as the last step of `docs:build` (design decision 5). Verify with a temporary broken anchor in a guide that the build fails and names the source page and the anchor, then remove it.
- [x] 4.2 Check search on the built documentation site. Verify that searching `averageSince` in a preview (`npx vitepress preview docs`) lists both the history guide and the reference entry.

## 5. CI

- [ ] 5.1 Add a `docs` job to `.forgejo/workflows/ci.yml` (`node:24`, manual clone like the other jobs, `npm ci`, `npm run docs:build`, upload `docs/.vitepress/dist` as artifact `docs-site` with `actions/upload-artifact@v4`, falling back to `@v3`). Verify on a pushed branch that the job is green and the artifact downloads and opens in a browser after extraction.
- [ ] 5.2 Push a commit with a deliberately broken guide link on a scratch branch. Verify the `docs` job fails, then delete the branch.

## 6. Contributor documentation

- [x] 6.1 Add a "Documentation site" section to the README (or `CONTRIBUTING.md` if one exists by then) covering `npm run docs:dev`, `npm run docs:build`, `DOCS_BASE`, the `repository` field in `docs/package.json`, and where the CI artifact is. Verify the commands work as written from a clean checkout.
