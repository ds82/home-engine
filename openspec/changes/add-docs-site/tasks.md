# Tasks

## 1. Site skeleton

- [ ] 1.1 Create the private workspace `docs/` (`@home-engine/docs`) with `vitepress` as a dev dependency. Add it to the root `workspaces`, add root scripts `docs:dev` and `docs:build`, and git-ignore and Prettier-ignore `docs/.vitepress/dist`, `docs/.vitepress/cache` and `docs/api`. Verify `npm ci` succeeds and `npm run docs:build` builds the existing guides.
- [ ] 1.2 Write `docs/.vitepress/config.ts` (design decisions 1 and 4):
  - title;
  - base path from `DOCS_BASE`;
  - navigation with the SDK version;
  - a sidebar grouping the rule guides, migration guides and performance;
  - local search;
  - edit links to the Forgejo repository;
  - `cleanUrls: false`.

  Verify that a build with `DOCS_BASE=/home-engine/`, served from a sub-directory by `npx serve`, loads every page and asset.
- [ ] 1.3 Make `scripts/check-docs.mjs` skip `docs/api/`, `docs/.vitepress/` and `docs/node_modules/`. Verify `npm run docs:check` still reports the same number of samples from the guides.

## 2. Home page and getting started

- [ ] 2.1 Add a `#region quick-start` marker around the README's quick start, removing relative links from that region. Create `docs/getting-started.md`, which includes it (design decision 3). Verify the page renders the quick start and the README still reads correctly on Forgejo.
- [ ] 2.2 Write `docs/index.md` with the home layout: a short pitch, three feature blurbs, and buttons to "Getting started" and "API reference". Verify the built home page links resolve.
- [ ] 2.3 Rewrite links from guides to files outside `docs/` as absolute repository URLs. Verify `npm run docs:build` reports no dead links.

## 3. SDK API reference

- [ ] 3.1 Add `typedoc`, `typedoc-plugin-markdown` and `typedoc-vitepress-theme` to the docs workspace, with a `typedoc.json` for `packages/sdk/src/index.ts`, output to `docs/api/`, and the generated sidebar included in the VitePress config. Add the root script `docs:api` and run it before `docs:dev` and `docs:build`. Verify the reference pages build and `onChange` shows its overloads and links to `StateEvent`.
- [ ] 3.2 Enable `validation.notDocumented` and `invalidLink` with `treatValidationWarningsAsErrors`, then add or complete the doc comments the build reports, including the overload signatures, `HassEntities` and `HassServices`. Verify `npm run docs:api` passes, and fails naming the symbol when a comment is removed from one export.
- [ ] 3.3 Add `@category` tags to the SDK's exports (Rules, Triggers, Scheduling, State, Actions, History, Storage, Logging, Types) so the reference sidebar is grouped. Verify that the sidebar shows those groups and the SDK's lint, typecheck and tests still pass.

## 4. Link and search checks

- [ ] 4.1 Write `scripts/check-site-links.mjs`, which checks every internal link with a fragment in the built HTML against the target page's element IDs and runs as the last step of `docs:build` (design decision 5). Verify with a temporary broken anchor in a guide that the build fails and names the source page and the anchor, then remove it.
- [ ] 4.2 Check search on the built site. Verify that searching `averageSince` in a preview (`npx vitepress preview docs`) lists both the history guide and the reference entry.

## 5. CI

- [ ] 5.1 Add a `docs` job to `.forgejo/workflows/ci.yml` (`node:24`, manual clone like the other jobs, `npm ci`, `npm run docs:build`, upload `docs/.vitepress/dist` as artifact `docs-site` with `actions/upload-artifact@v4`, falling back to `@v3`). Verify on a pushed branch that the job is green and the artifact downloads and opens in a browser after extraction.
- [ ] 5.2 Push a commit with a deliberately broken guide link on a scratch branch. Verify the `docs` job fails, then delete the branch.

## 6. Contributor documentation

- [ ] 6.1 Add a "Documentation site" section to the README (or `CONTRIBUTING.md` if one exists by then) covering `npm run docs:dev`, `npm run docs:build`, `DOCS_BASE`, and where the CI artifact is. Verify the commands work as written from a clean checkout.
