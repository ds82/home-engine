# Spec Delta

## MODIFIED Requirements

### Requirement: Multi-architecture image
The project SHALL publish the image for `linux/amd64` and `linux/arm64` under a single multi-arch tag. Tags SHALL follow semantic versioning (`X.Y.Z`, `X.Y`, `X`) plus `latest` for the newest stable release. A prerelease from `main` SHALL be tagged with its full version and with its channel (`alpha`), which points to the newest prerelease of that channel. A branch build SHALL be tagged `X.Y.Z-beta.<branch slug>.<run>` and `branch-<branch slug>`.

#### Scenario: Raspberry Pi pull
- **WHEN** a user pulls the image on an arm64 host
- **THEN** the arm64 variant is pulled automatically and starts successfully

#### Scenario: Prerelease tags
- **WHEN** `1.0.0-alpha.3` is released from `main`
- **THEN** the image is available as `1.0.0-alpha.3` and `alpha`, and `latest`, `1.0` and `1` are unchanged

#### Scenario: Branch tags
- **WHEN** CI run 42 passes for branch `feat/sun-offset`
- **THEN** the image is available as `branch-feat-sun-offset`, and no semver or `latest` tag changes
