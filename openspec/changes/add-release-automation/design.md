# Design

## Context

See proposal.md for why. Today:

- **Forge:** the repository lives on GitHub (`github.com/ds82/home-engine`). Forgejo only mirrors it and runs no workflows.
- **CI** (`.github/workflows/ci.yml`) runs on every branch push and on pull requests, with four jobs on `ubuntu-latest`: `check`, `docs`, `container` (smoke test) and `e2e`. They use `actions/checkout` with its default depth of 1, so there are no tags and no history.
- **`release.yml`** builds and pushes the multi-arch image to `ghcr.io/ds82/home-engine` through `scripts/build-image.sh` when a `v*` tag is pushed, logging in with `GITHUB_TOKEN`. On branches it only does a dry run, and only when `docker/` changes. A job in one workflow cannot `need` a job in another, so this workflow cannot wait for CI.
- **npm publishing** is manual: `scripts/publish-npm.sh` checks the tree and the login, builds, tests and publishes the four packages in order. It skips versions that already exist.
- **Versions:** the published packages are at `1.0.0-alpha.1` with exact internal pins, and carry `repository` metadata pointing at GitHub. The lockfile records the workspace versions, and the Dockerfile runs `npm ci` against it. `engineVersion()` reads the engine's `package.json`, and the image label gets `VERSION` as a build argument.
- **History:** commits up to `cd74c20` are plain sentences; the six after it are conventional, ending at `1cf64d7`, which was published as `1.0.0-alpha.1` and is tagged `v1.0.0-alpha.1`. No image exists for that version on GHCR.
- **Tools:** git-cliff 2.14 is available as an npm package with prebuilt binaries. Behaviour measured with `--bumped-version`:
  - `v1.0.0-alpha.1` + any commit → `v1.0.0-alpha.2` (the prerelease number counts up, whatever the bump level);
  - `v1.1.0` + `feat` → `v1.2.0`;
  - `v1.1.0` + `feat!` → `v2.0.0`;
  - after a stable tag, a `chore` alone still gives a patch bump. Whether a release is due therefore has to be decided separately.

## Goals / Non-Goals

**Goals:**
- One script decides the version for every build (main, branch, rerun), so the workflows only call it.
- Everything that runs in CI can also run locally with `--dry-run`. The maintainer can then check a version or the release notes before pushing.
- The scripts stay forge-neutral: only the workflow file and the release call know about GitHub.

**Non-Goals:**
- Commit linting of the old history, and rewriting it.
- Signed tags, image attestations, SBOMs. (npm provenance comes for free with trusted publishing, decision 7.)
- Pruning old branch images from the registry.

## Decisions

### 1. commitlint with a plain `core.hooksPath` hook

- **Rules:** `@commitlint/cli` with `@commitlint/config-conventional`, tightened in `commitlint.config.js`:
  - `type-enum` lists the eleven types from the spec;
  - `header-max-length` is 72;
  - `scope-enum` is a warning, not an error, listing `sdk`, `engine`, `typegen`, `cli`, `docker`, `docs`, `examples`, `ci`, `release`, `deps` and `openspec`. Scopes stay readable, and a new area does not block a commit.
- **Hook:** `.githooks/commit-msg` runs `npx --no -- commitlint --edit "$1"`.
- **Installation:** the root `prepare` script runs `git config core.hooksPath .githooks`. It does nothing outside a git work tree (in the Docker build and in tarballs), so `npm ci` never fails there.

*Alternatives:*
- husky: does the same with an extra dependency and a `.husky/` layout.
- git-cliff alone: cannot reject messages.
- A hand-written regex: duplicates commitlint's parsing of footers and `!`.

### 2. CI commit check as its own job

A `commits` job in `ci.yml` checks out with `actions/checkout` and `fetch-depth: 0` (full history and tags), and fetches `main`. It then lints a range:

| Push | Range |
| --- | --- |
| To `main` | `${{ github.event.before }}..HEAD` |
| First push of a branch (`before` is all zeros) | `origin/main..HEAD` |
| Further push to a branch | `before..HEAD` |
| Pull request | `${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}` |

Each range is cut at the baseline: `commitlint --from <base> --to HEAD`, where `<base>` is the later of the range start and `v1.0.0-alpha.1`. The release jobs `need` this job like the others.

### 3. One version script: `scripts/release/version.mjs`

A Node script without dependencies prints JSON: `{ version, channel, distTag, releasable, tag, notes }`. It takes `--branch <name> --run <n>`.

1. **Rerun:** if `HEAD` already carries a `v*` tag, use that version (`releasable: true`). This makes reruns resumable (decision 5).
2. **Base:** the newest tag reachable from `HEAD`, from `git describe --tags --abbrev=0 --match 'v[0-9]*'`.
3. **Releasable** means there is a release-worthy commit, or a graduation is due:
   - a commit since the base whose type is `feat`, `fix` or `perf`, or that is breaking. git-cliff's `--unreleased --context` JSON gives the parsed commits;
   - or a graduation (channel `stable` while the base is a prerelease).
4. **Version:**

   | Channel and base | Version |
   | --- | --- |
   | `stable`, base stable | `git cliff --bumped-version` |
   | `stable`, base a prerelease (graduation) | the base's core (`1.0.0-alpha.7` → `1.0.0`) |
   | Prerelease channel, base a prerelease of the same channel | `git cliff --bumped-version` (counts the number up) |
   | Prerelease channel, base stable or another channel | the bumped core with `-<channel>.1` (`v1.0.0` + `feat` → `1.1.0-beta.1`) |

5. **Branch builds** (`--branch` other than `main`): `<core of the version>-beta.<slug>.<run>`, where the core is the computed version when releasable and otherwise the base. The slug is lower-cased, every run of other characters becomes `-`, trimmed, and cut to 40 characters. Docker tags allow 128 characters and must not start with `.` or `-`.
6. **Release notes:** `git cliff --unreleased --tag v<version> --strip all`.

The release channel lives in the root `package.json` as `"releaseChannel": "alpha"`. Graduation is one reviewed commit that sets `"stable"`. *Alternative:* a GitHub repository variable. Rejected: it is invisible in review and not part of the history.

git-cliff is a pinned root dev dependency (`git-cliff` on npm), so CI and developers run the same version through `npx git-cliff`. `cliff.toml`:
- parses conventional commits;
- skips unconventional ones (`filter_unconventional = true`), so the old history never reaches the notes;
- groups the notes by Features, Fixes, Performance, Documentation, Refactoring and Other;
- matches only release tags (`tag_pattern = "v[0-9].*"`).

### 4. Placeholder version and stamping in CI

- **In the repository:** the four published packages carry `0.0.0-dev`, with exact `0.0.0-dev` internal pins and the lockfile to match. Workspaces still resolve locally, and anything built outside CI is clearly a development build.
- **In CI:** `scripts/release/set-version.mjs <version>` rewrites, in the CI checkout only:
  - the `version` of the four packages;
  - every `@home-engine/*` dependency on them;
  - the matching `package-lock.json` entries.

  It runs before the npm build and before the image build. The Dockerfile's `npm ci` then sees a consistent lockfile, and `engineVersion()` reports the real version.
- `build-image.sh` already takes `VERSION` from the environment.

*Alternative:* `npm version --workspaces`. It does not rewrite the exact pins between the workspaces or the lockfile's workspace entries.

### 5. The tag reserves the version

The `version` job of a `main` release pushes `v<version>` before anything is published.

- **Tag rejected:** if the push is rejected because the tag exists on another commit, a concurrent run won the race. The job fails before publishing anything.
- **Rerun:** the tag points at `HEAD`, so step 1 of decision 3 reuses the version, and every publishing step skips what already exists:
  - npm, through `publish-npm.sh`'s existing check;
  - the image, through `docker buildx imagetools inspect` before building;
  - the GitHub Release, through `gh release view`.
- **Failed publish:** the tag stays, and the run is fixed by rerunning it. A tag without packages is visible, not silent. To abandon a version, delete the tag by hand.

*Alternatives:*
- Tagging last: two runs could publish the same version from different commits.
- A `concurrency` group alone: it serializes runs but does not make reruns resumable. It is used in addition (decision 6).

### 6. Workflow layout: everything in `ci.yml`

Because jobs in different workflows cannot depend on each other, the publishing jobs move into `ci.yml`, and `release.yml` is deleted. Each publishing job `needs: [commits, check, docs, container, e2e]`. *Alternative:* a separate workflow started by `workflow_run`. Rejected: it always runs the default branch's copy of the workflow, which makes branch builds and changes to the release jobs hard to test.

All jobs run on `ubuntu-latest`; Node jobs use `actions/setup-node` with `.nvmrc`, Docker jobs the runner's Docker.

| Job | Runs on | Permissions | Does |
| --- | --- | --- | --- |
| `version` | every push | `contents: write` | full checkout; runs `version.mjs`; on `main` and when releasable, pushes the tag. Outputs `version`, `distTag`, `releasable`. |
| `npm` | `main` and releasable | `id-token: write` | `set-version.mjs`, then `publish-npm.sh --ci` with the dist-tag. |
| `image` | `main` and releasable, or any other branch | `packages: write` | `set-version.mjs`, then `build-image.sh --push`. |
| `release` | `main` and releasable, `needs: [npm, image]` | `contents: write` | `gh release create v<version> --notes-file …`, with `--prerelease` for channel releases; skipped when `gh release view` finds one. |

The workflow's default permissions stay `contents: read`; each job asks only for what it needs. The publishing jobs run only for `push` events, never for `pull_request`, so a pull request from a fork can neither publish nor get a writable token. The release jobs on `main` share a `concurrency` group `release-main` with `cancel-in-progress: false`, so two pushes release one after the other; the tag stays the lock (decision 5).

Image tags for the `image` job:

| Build | Tags |
| --- | --- |
| Stable | `X.Y.Z`, `X.Y`, `X`, `latest` (as today) |
| Prerelease from `main` | `X.Y.Z-alpha.N` and `alpha` |
| Branch | `X.Y.Z-beta.<slug>.<run>` and `branch-<slug>` |

The registry stays `vars.IMAGE` or `ghcr.io/<owner>/<repo>`, as in today's `release.yml`.

**Tag pushes and the token:** they use `GITHUB_TOKEN`. GitHub does not start workflows for pushes made with it, so the tag push does not loop.

### 7. `publish-npm.sh --ci` with trusted publishing

- **Authentication:** npm trusted publishing. Each of the four packages has a trusted publisher on npmjs.com for repository `ds82/home-engine` and workflow `ci.yml`. In the `npm` job, `npm publish` exchanges the job's OIDC token (`id-token: write`) for a short-lived publish token. No npm secret exists, and npm adds a provenance attestation automatically.
- **npm version:** trusted publishing needs npm 11.5.1 or later. `--ci` checks `npm --version` and fails with a clear message when it is older; the job runs `npm install -g npm@11` before the script if the bundled npm is older.
- **Checks:** `--ci` skips the clean-tree check (the stamped `package.json` files are dirty by design) and the `npm whoami` check, which an OIDC-only job cannot pass.
- **Tag:** `NPM_TAG` comes from the `version` job.
- The build and tests already ran in `check`. The script still runs them, which keeps one code path. It costs about a minute.

*Alternative:* a granular `NPM_TOKEN` secret. Rejected: a long-lived token that can publish without 2FA, which trusted publishing makes unnecessary.

### 8. Agent instructions in `CLAUDE.md`

A project `CLAUDE.md` holds:
- the commit format with the type list and the scope list;
- a one-line note that it overrides the style of the history before `v1.0.0-alpha.1`;
- a pointer to the commitlint config.

The local `/commit` command already defers to a CLAUDE.md convention. An `AGENTS.md` is not added. Claude Code is the only agent in use, and the file can be symlinked later.

## Risks / Trade-offs

- **[Risk]** A breaking change during the alpha only bumps the alpha number (`1.0.0-alpha.3` → `1.0.0-alpha.4`). → That is how a prerelease series works: nothing before `1.0.0` promises compatibility. The release notes still list the breaking change.
- **[Risk]** Every branch push builds and pushes a two-platform image, which takes minutes and fills the registry. → The job only runs after the rest of CI passes. Pruning is a non-goal, and old `*-beta.*` tags can be cleaned by hand or with a registry cleanup rule later.
- **[Risk]** Trusted publishers are configured per package, and only for packages that already exist. → All four were published as `1.0.0-alpha.1`. A new package needs one manual first publish and its own trusted publisher before CI can publish it.
- **[Risk]** Renaming `ci.yml` or the repository breaks npm publishing. → The trusted publisher names both; the task list and `CONTRIBUTING.md` say so.
- **[Risk]** A tag push succeeds, then publishing fails, and nobody reruns. → The tag exists without packages. The next releasable push computes the next version from that tag and skips the version. That leaves a gap in the numbering, but no wrong artifact.
- **[Trade-off]** `package.json` in the repository no longer shows the released version. → The tag, `npm view` and the release page do. A development build clearly reports `0.0.0-dev`.
- **[Risk]** `npm ci` in the Docker build: the root `workspaces` list `packages/cli` and `docs`, but the Dockerfile copies neither `package.json`. → Today's image build passes with `docs` missing. The tasks verify that it also passes with `packages/cli` missing. If it does not, the Dockerfile copies `packages/cli/package.json`.

## Migration Plan

1. Done before this change: the repository moved to GitHub, and the tag `v1.0.0-alpha.1` on `1cf64d7` exists there. No `1.0.0-alpha.1` image is built for GHCR.
2. Land the commit tooling (hook, commitlint, `CLAUDE.md`, the `commits` CI job). From here on every commit is checked.
3. Configure the trusted publishers on npmjs.com. Then land the version scripts, `cliff.toml`, the placeholder versions and the new `ci.yml` jobs in one go, and delete `release.yml`.
4. The first releasable push to `main` releases `1.0.0-alpha.2`. Make the GHCR package public after its first push.

**Rollback:** revert the `ci.yml` change. Releasing by hand with `publish-npm.sh` and a tag-triggered `release.yml` from git history works as before. Tags and published versions stay.

## Open Questions

- Does `npm publish --workspace <dir>` from the repository root pick up the OIDC token like a plain `npm publish`? The scratch-branch dry run cannot show it; the first `main` release does. The fallback is `cd <dir> && npm publish`.
