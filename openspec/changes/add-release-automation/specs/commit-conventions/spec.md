# Spec Delta

## Purpose

Defines the commit message format the repository accepts, so release versions and release notes can be derived from the history, and where the format is enforced.

## ADDED Requirements

### Requirement: Conventional commit format
Every commit after the baseline tag `v1.0.0-alpha.1` SHALL have a first line `type(scope)!: subject`, where:
- type is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style` or `revert`;
- the scope and `!` are optional;
- the subject is not empty;
- the first line is at most 72 characters.

A breaking change SHALL be marked with `!` or a `BREAKING CHANGE:` footer. Merge commits created by git are exempt.

#### Scenario: Valid feature commit
- **WHEN** a commit message starts with `feat(sdk): add sunset offset to onSun`
- **THEN** the message is accepted

#### Scenario: Plain sentence rejected
- **WHEN** a commit message starts with `Add sunset offset to onSun`
- **THEN** the message is rejected with an error naming the missing type

#### Scenario: Unknown type rejected
- **WHEN** a commit message starts with `feature: add sunset offset`
- **THEN** the message is rejected with an error listing the allowed types

#### Scenario: Overlong first line rejected
- **WHEN** a commit message's first line has 73 characters
- **THEN** the message is rejected with an error naming the 72-character limit

#### Scenario: Merge commit
- **WHEN** git creates a merge commit with its default message `Merge branch 'x'`
- **THEN** the message is accepted

### Requirement: Local commit check
After `npm ci` or `npm install` in a clone, git SHALL check each new commit message against the format and refuse the commit when it does not conform. The check SHALL need nothing beyond the installed dev dependencies.

#### Scenario: Hook rejects a commit
- **WHEN** a developer runs `git commit -m "Fix the thing"` in a clone after `npm ci`
- **THEN** git aborts the commit and prints the format error

#### Scenario: Hook accepts a commit
- **WHEN** a developer runs `git commit -m "fix(engine): reconnect after HA restart"`
- **THEN** the commit is created

### Requirement: CI commit check
CI SHALL check every commit a push adds to a branch and fail when any of them does not conform. On a new branch it SHALL check the commits that are not on `main`. Commits that are reachable from the baseline tag SHALL NOT be checked.

#### Scenario: Bypassed hook caught in CI
- **WHEN** a commit made with `git commit --no-verify -m "wip"` is pushed
- **THEN** the CI commit check fails and names the commit

#### Scenario: Old history ignored
- **WHEN** CI checks a branch whose history contains the plain-sentence commits before `v1.0.0-alpha.1`
- **THEN** those commits are not reported

### Requirement: Agent instructions
The repository SHALL contain agent instructions, read by coding agents such as Claude Code, that require the commit format and state that it takes precedence over the style of the older history.

#### Scenario: Agent commits
- **WHEN** a coding agent that reads the repository's instructions creates a commit
- **THEN** the commit message conforms to the format
