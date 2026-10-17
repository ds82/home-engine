# Proposal

## Why

Releases are manual today. Someone picks a version, edits four `package.json` files, runs `scripts/publish-npm.sh` and pushes a `v*` tag for the image. `1.0.0-alpha.1` went to npm this way, and the tag `v1.0.0-alpha.1` marks the commit, but no image was built for it. Commit messages are free-form sentences, so nothing can tell whether a change is a fix, a feature or a breaking change. Releasing should follow from what was merged: with Conventional Commits, git-cliff can compute the next semantic version and write the release notes, and CI can publish every release from `main`.

## What Changes

- **Conventional Commits become mandatory** for every commit from the baseline tag `v1.0.0-alpha.1` on:
  - a `commit-msg` hook, installed by `npm ci`/`npm install`, rejects a non-conforming message locally;
  - a CI job checks every pushed commit, so a commit that skipped the hook still fails the build;
  - a project `CLAUDE.md` tells coding agents the convention, which overrides the plain-sentence style of the older history.
- **npm publishing uses trusted publishing.** The release job authenticates to npm with GitHub's OIDC token, so no npm token is stored anywhere, and every published version carries a provenance attestation that links it to the commit and the workflow run.
- **The version comes from the commits.** A `cliff.toml` configures git-cliff. Each push to `main` computes the next version from the commits since the last release tag:
  - `feat` bumps the minor version, `fix`/`perf` the patch version, and a breaking change the major version;
  - commits of other types alone (`docs`, `chore`, `ci`, …) produce no release.
- **The alpha channel lasts until graduation.** While a release channel setting in the repository says `alpha`, `main` releases `1.0.0-alpha.2`, `1.0.0-alpha.3`, …. Changing the setting to stable makes the next release `1.0.0`, followed by normal semver releases.
- **`main` publishes automatically** once all CI jobs pass:
  - the git tag `vX.Y.Z` is pushed first and reserves the version;
  - the four npm packages are published under the dist-tag `alpha` (`latest` once stable);
  - the multi-arch image goes to GHCR;
  - a GitHub Release carries the git-cliff notes.

  A failed run can be rerun and resumes where it stopped.
- **Branch builds publish an image only.** Each push to another branch publishes the image as `X.Y.Z-beta.<branch>.<run>`, plus a moving tag `branch-<branch>`, after CI passes. npm gets only releases from `main`.
- **Versions are set in CI, not in the repository.** The repository's `package.json` files carry the placeholder version `0.0.0-dev`. CI writes the computed version into the build before it publishes. No bot commits to `main`.
- **BREAKING (for the maintainer):** pushing a `v*` tag by hand no longer publishes anything. Tags are created by CI, and `.github/workflows/release.yml` is removed.
- **Not in scope:**
  - publishing npm prereleases from branches;
  - a `CHANGELOG.md` file in the repository;
  - deploying the documentation site to GitHub Pages.

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
- **Removed:** `.github/workflows/release.yml`. Its image publishing moves into `ci.yml`, so it can wait for the tests.
- **Changed files:**
  - root `package.json`: `prepare` script that sets `core.hooksPath`, dev dependencies `@commitlint/cli`, `@commitlint/config-conventional` and `git-cliff`, and the release channel setting;
  - the version and internal pins of the four published packages become `0.0.0-dev`;
  - `scripts/publish-npm.sh` gains a CI mode;
  - `.github/workflows/ci.yml` gains a commit check job and the release and branch-image jobs.
- **No secrets.** The workflow's `GITHUB_TOKEN` pushes the tag, creates the GitHub Release and pushes the image to GHCR; npm accepts the OIDC token. `vars.IMAGE` with `REGISTRY_TOKEN` stays as the way to publish the image elsewhere.
- **One-time setup by the maintainer:**
  - on npmjs.com, a trusted publisher for each of the four packages: repository `ds82/home-engine`, workflow `ci.yml`;
  - after the first image push, the GHCR package `ds82/home-engine` set to public.
- **Baseline:** the tag `v1.0.0-alpha.1` on `1cf64d7`, the commit `1.0.0-alpha.1` was published from, already exists on GitHub. It is the baseline for git-cliff and the commit check. No `1.0.0-alpha.1` image exists on GHCR, and none is built: the first image there is `1.0.0-alpha.2`.
- **Docs:** a contributing section on the commit format and the release flow, and the image tags in the configuration/quick start docs.
