# Spec Delta

## Purpose

Defines how releases happen without manual steps: how the next version is derived from the commit history, what a push to `main` or to another branch publishes, and how a release channel is graduated to stable.

## ADDED Requirements

### Requirement: Version derived from commits
The next version SHALL be computed from the conforming commits since the newest release tag (`vX.Y.Z` or `vX.Y.Z-<channel>.N`) reachable from the commit being built:
- a breaking change bumps the major version;
- otherwise, `feat` bumps the minor version;
- otherwise, `fix` or `perf` bumps the patch version.

When none of these commits exists, there SHALL be no next version, except for a graduation (see Release channel).

#### Scenario: Fix after a stable release
- **WHEN** the newest release tag is `v1.2.0` and the only new commit is `fix(engine): …`
- **THEN** the next version is `1.2.1`

#### Scenario: Feature after a stable release
- **WHEN** the newest release tag is `v1.2.0` and the new commits are a `fix` and a `feat`
- **THEN** the next version is `1.3.0`

#### Scenario: Breaking change after a stable release
- **WHEN** the newest release tag is `v1.2.0` and a new commit is `feat(sdk)!: …`
- **THEN** the next version is `2.0.0`

#### Scenario: Nothing releasable
- **WHEN** the new commits since `v1.2.0` are only `docs`, `chore` and `ci` commits
- **THEN** there is no next version and nothing is released

### Requirement: Release channel
The repository SHALL hold one release channel setting, either a prerelease identifier such as `alpha` or `stable`. While it names a prerelease identifier, every release from `main` SHALL be a prerelease of that identifier, and its number SHALL count up from the newest tag of that channel. Changing the setting to `stable` while the newest release tag is a prerelease SHALL make the next release from `main` that version without the prerelease part, even when no releasable commit is new.

#### Scenario: Alpha release
- **WHEN** the channel is `alpha`, the newest release tag is `v1.0.0-alpha.1`, and a `feat` commit is pushed to `main`
- **THEN** `main` releases `1.0.0-alpha.2`

#### Scenario: Graduation
- **WHEN** the channel is changed to `stable` in a `chore(release)` commit pushed to `main`, and the newest release tag is `v1.0.0-alpha.7`
- **THEN** `main` releases `1.0.0`

#### Scenario: New prerelease series after stable
- **WHEN** the newest release tag is `v1.0.0`, the channel is changed to `beta`, and a `feat` commit is pushed to `main`
- **THEN** `main` releases `1.1.0-beta.1`

### Requirement: Release from main
After all CI jobs pass for a push to `main` with a next version, CI SHALL release that version from the pushed commit:
- the git tag `v<version>` on that commit;
- the npm packages `@home-engine/sdk`, `@home-engine/engine`, `@home-engine/typegen` and `home-engine`, each with that version and with exact dependencies on each other at that version;
- the container image tagged with that version;
- a release on the forge, with release notes grouped by commit type.

When any CI job fails, nothing SHALL be released.

#### Scenario: Feature merged
- **WHEN** a `feat` commit lands on `main` and CI passes
- **THEN** tag, npm packages, image and release notes for the new version exist, and `npm view home-engine@<version> dependencies` names `@home-engine/engine@<version>`

#### Scenario: CI fails
- **WHEN** a `fix` commit lands on `main` and the e2e job fails
- **THEN** no tag, package, image or release is created

### Requirement: npm dist-tags
Releases from `main` SHALL be published to npm under the dist-tag of the release channel (`alpha`) while the channel is a prerelease, and under `latest` once it is `stable`. A prerelease SHALL never move `latest`.

#### Scenario: Alpha install
- **WHEN** `1.0.0-alpha.3` has been released
- **THEN** `npm install home-engine@alpha` installs `1.0.0-alpha.3` and `latest` is unchanged

### Requirement: Resumable release
A release SHALL be resumable: rerunning a failed release job for the same commit SHALL publish only what is missing, under the same version. Two release jobs SHALL NOT publish the same version for different commits.

#### Scenario: Image push failed
- **WHEN** a release job published the npm packages but failed pushing the image, and the job is rerun
- **THEN** the rerun skips the npm packages and publishes the image under the same version

#### Scenario: Concurrent pushes
- **WHEN** two pushes to `main` start release jobs that compute the same next version
- **THEN** only the first job releases it, and the other fails without publishing anything

### Requirement: Versions not committed
The repository's `package.json` files SHALL carry a placeholder version. Release jobs SHALL set the computed version only in their build, and SHALL NOT push commits.

#### Scenario: After a release
- **WHEN** a release from `main` has completed
- **THEN** `main` has no new commit, and the release is visible only as tag, packages, image and release notes

### Requirement: Branch builds publish an image
After all CI jobs pass for a push to a branch other than `main`, CI SHALL publish the container image as `<next core version>-beta.<branch slug>.<run number>` and move the tag `branch-<branch slug>` to it. Branch builds SHALL NOT publish npm packages, push git tags or create releases. The branch slug SHALL be the branch name in lower case with every run of other characters than letters and digits replaced by `-`, without leading or trailing `-`, and cut to 40 characters.

#### Scenario: Feature branch build
- **WHEN** CI run 42 passes for branch `feat/Sun-Offset` and the next version would be `1.0.0-alpha.3`
- **THEN** the image is published as `1.0.0-beta.feat-sun-offset.42` and `branch-feat-sun-offset` points to it, and npm is unchanged

#### Scenario: Nothing releasable on a branch
- **WHEN** a branch contains only `docs` commits since the newest release tag `v1.0.0-alpha.2`
- **THEN** the image is still published, with the core version of `1.0.0-alpha.2`
