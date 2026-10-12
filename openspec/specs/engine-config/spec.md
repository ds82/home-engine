# engine-config Specification

## Purpose

Defines how operators configure the engine: environment variables, secret files and defaults. Invalid configuration fails fast with clear messages instead of misbehaving at runtime.

## Requirements

### Requirement: Environment variable configuration
The engine SHALL be configured through environment variables, with the following names and defaults:
- `HA_URL` (required unless in Supervisor mode)
- `HA_TOKEN` (required unless in Supervisor mode)
- `RULES_DIR` (`/rules`)
- `DATA_DIR` (`/data`)
- `LOG_LEVEL` (`info`)
- `LOG_FORMAT` (`pretty`)
- `HOT_RELOAD` (`true`)
- `WATCH_POLL` (`auto`; one of `auto`, `true`, `false`)
- `DISABLED_RULES` (empty)
- `DRY_RUN` (`false`)
- `TIME_ZONE` (from Home Assistant)
- `HTTP_PORT` (`8080`)
- `NPM_INSTALL` (`true`)

#### Scenario: Defaults applied
- **WHEN** only `HA_URL` and `HA_TOKEN` are set
- **THEN** the engine loads rules from `/rules`, stores data in `/data`, logs at `info` in pretty format, and serves the health endpoint on port 8080

#### Scenario: Disabled rules list parsed
- **WHEN** `DISABLED_RULES` is `lights/*, climate#heating`
- **THEN** both patterns are applied as disabled-rule patterns with surrounding whitespace ignored

### Requirement: Secret files
For `HA_TOKEN` and `HA_URL`, the engine SHALL also accept a `<NAME>_FILE` variant pointing to a file whose trimmed content is used as the value (Docker/Kubernetes secrets). Setting both the variable and its `_FILE` variant SHALL be a configuration error.

#### Scenario: Token from Docker secret
- **WHEN** `HA_TOKEN_FILE=/run/secrets/ha_token` is set and the file contains the token followed by a newline
- **THEN** the engine authenticates with the token without the trailing newline

#### Scenario: Both variants set
- **WHEN** both `HA_TOKEN` and `HA_TOKEN_FILE` are set
- **THEN** the engine exits at startup with an error naming both variables

### Requirement: Fail-fast validation
The engine SHALL validate all configuration at startup, before connecting. On invalid values it SHALL exit with a non-zero code and print one message per problem. Covered cases: missing required values, malformed URL, unknown log level/format, non-numeric port, and missing/unreadable rules directory.

#### Scenario: Missing token
- **WHEN** `HA_URL` is set but neither `HA_TOKEN`, `HA_TOKEN_FILE` nor `SUPERVISOR_TOKEN` is set
- **THEN** the engine exits with a non-zero code and a message stating that `HA_TOKEN` is required

#### Scenario: Several problems reported at once
- **WHEN** `LOG_LEVEL=verbose` and `HTTP_PORT=abc` are set
- **THEN** the engine reports both problems in the same startup failure

#### Scenario: Empty rules directory
- **WHEN** the rules directory exists but contains no rule files
- **THEN** the engine starts, logs a warning that no rules were found, and keeps watching for new files

### Requirement: Effective configuration logged
At startup, the engine SHALL log the effective configuration at `info` level with secrets redacted.

#### Scenario: Redacted startup log
- **WHEN** the engine starts with `HA_TOKEN` set
- **THEN** the startup log shows the token as `***` and shows all other effective values

### Requirement: Rules can read environment
Rule code SHALL be able to read environment variables of the engine process, so operators can pass rule-specific settings and secrets (e.g. API keys) through the container environment.

#### Scenario: Rule reads custom variable
- **WHEN** the container is started with `PUSHOVER_KEY=abc` and a rule reads that variable
- **THEN** the rule obtains `abc`
