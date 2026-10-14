# Proposal

## Why

Releases are manual today. Someone picks a version, edits four `package.json` files, runs `scripts/publish-npm.sh` and pushes a `v*` tag for the image. `1.0.0-alpha.1` went to npm this way, but no tag was pushed, so no image exists. Commit messages are free-form sentences, so nothing can tell whether a change is a fix, a feature or a breaking change. Releasing should follow from what was merged: with Conventional Commits, git-cliff can compute the next semantic version and write the release notes, and CI can publish every release from `main`.

## What Changes

- **Conventional Commits become mandatory** for every commit from the baseline tag `v1.0.0-alpha.1` on:
  - a `commit-msg` hook, installed by `npm ci`/`npm install`, rejects a non-conforming message locally;
  - a CI job checks every pushed commit, so a commit that skipped the hook still fails the build;
  - a project `CLAUDE.md` tells coding agents the convention, which overrides the plain-sentence style of the older history.
- **The version comes from the commits.** A `cliff.toml` configures git-cliff. Each push to `main` computes the next version from the commits since the last release tag:
  - `feat` bumps the minor version, `fix`/`perf` the patch version, and a breaking change the major version;
  - commits of other types alone (`docs`, `chore`, `ci`, …) produce no release.
- **The alpha channel lasts until graduation.** While a release channel setting in the repository says `alpha`, `main` releases `1.0.0-alpha.2`, `1.0.0-alpha.3`, …. Changing the setting to stable makes the next release `1.0.0`, followed by normal semver releases.
- **`main` publishes automatically** once all CI jobs pass:
  - the git tag `vX.Y.Z` is pushed first and reserves the version;
  - the four npm packages are published under the dist-tag `alpha` (`latest` once stable);
  - the multi-arch image goes to the registry;
  - a Forgejo release carries the git-cliff notes.

  A failed run can be rerun and resumes where it stopped.
- **Branch builds publish an image only.** Each push to another branch publishes the image as `X.Y.Z-beta.<branch>.<run>`, plus a moving tag `branch-<branch>`, after CI passes. npm gets only releases from `main`.
- **Versions are set in CI, not in the repository.** The repository's `package.json` files carry the placeholder version `0.0.0-dev`. CI writes the computed version into the build before it publishes. No bot commits to `main`.
- **BREAKING (for the maintainer):** pushing a `v*` tag by hand no longer publishes anything. Tags are created by CI, and `.forgejo/workflows/release.yml` is removed.
- **Not in scope:**
  - moving to GitHub (Actions, npm trusted publishing, provenance), which comes in a later change;
  - publishing npm prereleases from branches;
  - a `CHANGELOG.md` file in the repository.

## Capabilities

### New Capabilities

- `commit-conventions`: the commit message format the repository accepts, and where it is enforced (local hook, CI, agent instructions).
- `release-automation`: how versions are derived from commits, when and what `main` and other branches publish, the release channel and graduation, and how a failed release is resumed.

### Modified Capabilities

- `container-image`: the "Multi-architecture image" requirement's tag scheme gains the moving channel tag (`alpha`) for prereleases from `main` and the beta and `branch-<branch>` tags for branch builds.

## Impact

- **New files:**
  - `cliff.toml`;
  - `commitlint.config.js`;
  - `.githooks/commit-msg`;
  - `CLAUDE.md`;
  - `scripts/release/` (version computation, version stamping, branch slug).
- **Removed:** `.forgejo/workflows/release.yml`. Its image publishing moves into `ci.yml`, so it can wait for the tests.
- **Changed files:**
  - root `package.json`: `prepare` script that sets `core.hooksPath`, dev dependencies `@commitlint/cli`, `@commitlint/config-conventional` and `git-cliff`, and the release channel setting;
  - the version and internal pins of the four published packages become `0.0.0-dev`;
  - `scripts/publish-npm.sh` gains a CI mode;
  - `.forgejo/workflows/ci.yml` gains a commit check job and the release and branch-image jobs.
- **Secrets on Forgejo:**
  - `NPM_TOKEN`: a granular npm token for `@home-engine/*` and `home-engine`, allowed to publish without 2FA;
  - `REGISTRY_TOKEN`/`PACKAGES_READ_WRITE`, which already exist for the image;
  - a token that may push tags and create releases if the automatic token cannot.
- **One-time step:** tag `v1.0.0-alpha.1` on `1cf64d7`, the commit `1.0.0-alpha.1` was published from. It is the baseline for git-cliff and the commit check. Pushing it with the current `release.yml` also builds the missing `1.0.0-alpha.1` image.
- **Docs:** a contributing section on the commit format and the release flow, and the image tags in the configuration/quick start docs.
