# Tasks

## 1. Baseline

- [x] 1.1 Tag `v1.0.0-alpha.1` on `1cf64d7` (the published commit) and push it to GitHub. Verify that `git ls-remote --tags origin` lists the tag. (No `1.0.0-alpha.1` image is built for GHCR; the first image there is `1.0.0-alpha.2`.)

## 2. Commit conventions

- [ ] 2.1 Add `@commitlint/cli` and `@commitlint/config-conventional` as root dev dependencies. Add `commitlint.config.js` with the type list, `header-max-length` 72 and `scope-enum` as a warning (design decision 1). Verify that `echo "feat(sdk): x" | npx commitlint` passes, and that `Add x`, `feature: x` and a 73-character header each fail with the expected rule.
- [ ] 2.2 Add `.githooks/commit-msg` (executable) and a root `prepare` script that sets `core.hooksPath` only inside a git work tree. Verify that after `npm ci`, `git config core.hooksPath` is `.githooks`, that `git commit --allow-empty -m "Fix it"` is refused and `git commit --allow-empty -m "fix: it"` is accepted (then reset), and that `npm ci` still succeeds in a copy without `.git`.
- [ ] 2.3 Write the project `CLAUDE.md` (design decision 8): the commit format, the type and scope lists, its precedence over the older history, and a pointer to `commitlint.config.js`. Verify that the file names every type from `commitlint.config.js`.
- [ ] 2.4 Write `CONTRIBUTING.md` with the commit format, how the hook gets installed and what `--no-verify` leads to in CI. Link it from the README. Verify `npm run format:check` passes.
- [ ] 2.5 Add the `commits` job to `.github/workflows/ci.yml` (design decision 2): `actions/checkout` with `fetch-depth: 0`, a fetch of `main`, and the range logic for main pushes, first branch pushes, further branch pushes and pull requests, cut at `v1.0.0-alpha.1`. Verify on a scratch branch:
  - a first push with only conforming commits passes;
  - a push of a `--no-verify` commit `wip` fails and names it;
  - the old history is not reported.

  Delete the scratch branch afterwards.
- [ ] 2.6 Delete the memory note `conventional-commits.md` in the Claude Code project memory, now that `CLAUDE.md` and the hook record and enforce the format.

## 3. Version computation

- [ ] 3.1 Add `git-cliff` (pinned) as a root dev dependency and write `cliff.toml` (design decision 3): conventional parsing, `filter_unconventional`, `tag_pattern = "v[0-9].*"`, and groups for the notes. Verify that `npx git-cliff --unreleased` in the repository lists only commits after `v1.0.0-alpha.1`, and that `npx git-cliff --bumped-version` prints `v1.0.0-alpha.2` once a `feat` commit exists.
- [ ] 3.2 Add `"releaseChannel": "alpha"` to the root `package.json`. Write `scripts/release/version.mjs`, which prints `{ version, channel, distTag, releasable, tag, notes }` for `--branch <name> --run <n>`, with the rerun check, the base tag, the releasable check, the four version cases, the branch slug and the notes. Add `scripts` as a vitest project. Write `scripts/release/version.test.mjs` against temporary git repositories, covering every scenario of the release-automation spec:
  - "Version derived from commits": fix, feature, breaking, nothing releasable;
  - "Release channel": alpha, graduation, a new prerelease series after stable;
  - "Branch builds publish an image": feature branch, nothing releasable;
  - the rerun of a tagged `HEAD`.

  Verify `npm test` passes.
- [ ] 3.3 Write `scripts/release/set-version.mjs <version>` (design decision 4). Set the four published packages, their internal pins and the lockfile's workspace entries to `0.0.0-dev` in the repository. Write tests for stamping a copy of the manifests. Verify that:
  - `npm ci`, `npm run build` and `npm test` pass at `0.0.0-dev`;
  - after `node scripts/release/set-version.mjs 1.0.0-alpha.9` on a scratch copy, `npm ci` passes, `npm ls` resolves the workspaces at `1.0.0-alpha.9`, and `node packages/cli/bin/home-engine.js` still reaches the configuration check.
- [ ] 3.4 Add `--ci` to `scripts/publish-npm.sh` (design decision 7): skip the clean-tree and login checks, require npm 11.5.1 or later for trusted publishing, and use `NPM_TAG`. Update the header comment. Verify that `NPM_TAG=alpha scripts/publish-npm.sh --ci --dry-run` on a stamped tree dry-runs all four packages with the tag `alpha`, and that `--ci` with an older npm fails with a message naming the required version.

## 4. Publishing jobs

- [ ] 4.1 Make `scripts/build-image.sh` skip the build when every requested tag that names a version already exists in the registry (`docker buildx imagetools inspect`). Verify that `npm run build` is unaffected, and that the dry-run mode still builds both platforms.
- [ ] 4.2 Check that the Docker build's `npm ci` works with `packages/cli` in the workspaces but not copied. If it fails, copy `packages/cli/package.json` in the Dockerfile. Verify that `scripts/build-image.sh --dry-run` passes on a stamped tree (`set-version.mjs 1.0.0-alpha.9`), and that the image label and `engineVersion()` report `1.0.0-alpha.9` (`docker run … node -e` against the dry-run image, or the container smoke test with a stamped tree).
- [ ] 4.3 Add the `version`, `npm`, `image` and `release` jobs to `.github/workflows/ci.yml` (design decisions 5 and 6), with every publishing job needing `commits`, `check`, `docs`, `container` and `e2e`, running only for `push` events, and with the per-job permissions from decision 6. The `version` job pushes the tag only on `main` when the build is releasable, and fails when the tag push is rejected. The `release` job creates the GitHub Release with `gh release create` and the notes (`--prerelease` for channel versions), and skips an existing one. Add the `release-main` concurrency group. Delete `.github/workflows/release.yml`. Verify with `actionlint` that the workflow is valid.
- [ ] 4.4 Document the image tags (`alpha`, `X.Y.Z-alpha.N`, `branch-<slug>`) in `docs/configuration.md` or the quick start, and point the example `HOME_ENGINE_IMAGE` at the `alpha` tag while there is no stable release. Describe the release flow, the release channel, graduation and the trusted publishers (and that renaming `ci.yml` or the repository breaks them) in `CONTRIBUTING.md`. Verify that `npm run docs:build` and `npm run docs:check` pass.

## 5. Rollout

- [ ] 5.1 Ask the maintainer to add a trusted publisher on npmjs.com for each of `@home-engine/sdk`, `@home-engine/engine`, `@home-engine/typegen` and `home-engine` (repository `ds82/home-engine`, workflow `ci.yml`, no environment). Then push a scratch branch with a `fix` commit. Verify that all CI jobs pass, the image `1.0.0-beta.<slug>.<run>` and `branch-<slug>` exist, and npm and the tags are unchanged. Delete the branch.
- [ ] 5.2 Merge to `main`. Verify that `v1.0.0-alpha.2` exists on the commit, that `npm view home-engine@alpha version` and `npm view @home-engine/sdk@alpha version` print `1.0.0-alpha.2`, that `npm view home-engine@1.0.0-alpha.2 dependencies` pins `@home-engine/engine@1.0.0-alpha.2`, that that `npm view home-engine@1.0.0-alpha.2 dist.attestations` shows a provenance attestation, that the image tags `1.0.0-alpha.2` and `alpha` exist, and that the GitHub Release is marked as prerelease and shows grouped notes. Ask the maintainer to make the GHCR package `ds82/home-engine` public, then verify that `docker pull ghcr.io/ds82/home-engine:alpha` works without login. Rerun the workflow and verify it publishes nothing new and fails nowhere.
- [ ] 5.3 Push a `docs:` commit to `main`. Verify that no tag, package, image or release is created.
