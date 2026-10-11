# Spec Delta

## Purpose

Defines the contract of the published Docker image, so users can run the engine with their own rule files using standard container tooling (docker run, Compose, Kubernetes, Home Assistant add-on).

## ADDED Requirements

### Requirement: Multi-architecture image
The project SHALL publish the image for `linux/amd64` and `linux/arm64` under a single multi-arch tag. Tags SHALL follow semantic versioning (`X.Y.Z`, `X.Y`, `X`) plus `latest` for the newest stable release.

#### Scenario: Raspberry Pi pull
- **WHEN** a user pulls the image on an arm64 host
- **THEN** the arm64 variant is pulled automatically and starts successfully

### Requirement: Volumes for rules and data
The image SHALL declare `/rules` as the rules directory and `/data` as the persistent data directory. The engine SHALL never write to `/rules`. Installed user dependencies, build caches and storage SHALL live under `/data`.

#### Scenario: Rules mounted read-only
- **WHEN** `/rules` is mounted read-only and contains a `package.json` with dependencies
- **THEN** the engine installs the dependencies under `/data`, and rules importing them load successfully

#### Scenario: Host node_modules ignored
- **WHEN** `/rules` contains a `node_modules` directory created on the host (possibly for another CPU architecture)
- **THEN** the engine resolves rule dependencies only from its own installation under `/data`

### Requirement: Non-root execution
The container SHALL run the engine as a non-root user by default. It SHALL work when started with an arbitrary UID via `--user`, provided the mounted directories are accessible to that UID.

#### Scenario: Default user
- **WHEN** the container starts without `--user`
- **THEN** the engine process runs with a non-zero UID

#### Scenario: Data directory not writable
- **WHEN** `/data` is not writable by the process user
- **THEN** the engine exits at startup with a message naming the directory and the effective UID

### Requirement: Container health check
The image SHALL define a `HEALTHCHECK` that queries the liveness endpoint, so Docker marks the container unhealthy when the engine hangs.

#### Scenario: Hung process detected
- **WHEN** the liveness endpoint stops responding
- **THEN** Docker reports the container as `unhealthy`

### Requirement: Graceful shutdown
On SIGTERM or SIGINT, the engine SHALL stop accepting new triggers, run all rule teardowns, flush storage, close the WebSocket and exit with code 0 within 10 seconds. If shutdown exceeds that time, it SHALL exit with a non-zero code.

#### Scenario: docker stop
- **WHEN** `docker stop` sends SIGTERM
- **THEN** rule teardown callbacks run, pending storage writes are flushed, and the process exits with code 0 before Docker's kill timeout

#### Scenario: Teardown hangs
- **WHEN** a rule's teardown never resolves
- **THEN** the engine exits with a non-zero code after 10 seconds and logs the rule that blocked shutdown

### Requirement: Proper signal handling as PID 1
The engine SHALL receive signals correctly and SHALL NOT leave zombie processes when running as PID 1 (e.g. child processes from the dependency installer).

#### Scenario: Installer child reaped
- **WHEN** the dependency installer spawned at startup exits
- **THEN** no zombie process remains in the container

### Requirement: Minimal image
The image SHALL contain only the runtime, the engine, and the tools needed to install user npm dependencies. It SHALL NOT include build tool chains, test files or source maps of dev dependencies. Its compressed size per architecture SHALL be under 150 MB.

#### Scenario: Size budget
- **WHEN** the release pipeline builds the image
- **THEN** the pipeline fails if the compressed image size exceeds 150 MB for any architecture

### Requirement: Example compose file and starter rules
The project SHALL ship a documented `docker-compose.yml` example and an example rules directory. Running the example with a valid URL and token SHALL start the engine with at least one working example rule.

#### Scenario: Quick start
- **WHEN** a user copies the example compose file, sets `HA_URL` and `HA_TOKEN`, and runs `docker compose up`
- **THEN** the engine connects and the example rule logs that it is running
