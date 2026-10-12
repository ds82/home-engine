# Spec Delta

## Purpose

Governs how rule files and rules are loaded, started, stopped, reloaded and isolated from each other. This keeps the engine stable while users iterate on their rule files.

## ADDED Requirements

### Requirement: File evaluation is atomic
A rule file SHALL be evaluated once per load. Its rules SHALL start only after evaluation (including top-level `await`) completes successfully. If evaluation throws or rejects, none of the rules the file registered SHALL start, and the file SHALL be reported as failed with the error.

#### Scenario: Error after some registrations
- **WHEN** a file registers two rules and then throws at top level
- **THEN** neither rule starts, the file is reported as failed with the error and stack trace, and other files are unaffected

#### Scenario: Evaluation timeout
- **WHEN** a file's top-level evaluation does not settle within 30 seconds
- **THEN** the engine logs a warning naming the file, marks it as failed, and releases anything it registered

### Requirement: Rule start
After successful file evaluation, the engine SHALL start each enabled rule: for triggered rules it arms the triggers, and for setup rules it calls the setup function once. In both cases pending holds are restored (see rule-triggers). Setup functions MAY be async. A setup rule counts as running when its returned promise (if any) resolves.

#### Scenario: Async setup
- **WHEN** a setup rule is `async` and awaits a service call before registering listeners
- **THEN** the engine awaits it and marks the rule as running once the promise resolves

#### Scenario: Setup timeout
- **WHEN** a setup function's promise does not settle within 30 seconds
- **THEN** the engine logs a warning naming the rule, marks it as failed, and disposes any resources it registered so far

### Requirement: Automatic resource cleanup
Every listener, trigger, timer, pending sleep/wait and connection listener created by or on behalf of a rule SHALL be tracked per rule. This includes resources created through free SDK functions. All of them SHALL be released automatically when the rule is unloaded, without user code.

#### Scenario: Pending sleep cancelled on unload
- **WHEN** a rule body is awaiting `sleep("10m")` and the rule is unloaded
- **THEN** the code after the sleep never runs

#### Scenario: Listeners removed on unload
- **WHEN** a rule triggered by `binary_sensor.motion` is unloaded and the sensor changes
- **THEN** the unloaded rule's body is not invoked

### Requirement: Native timers in rule code are scoped
Calls to the global `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval` made from rule files (and local modules they import) SHALL behave as usual, but the engine SHALL track the timers per rule (or per file at top level). It SHALL cancel them when the rule or file is unloaded.

#### Scenario: setTimeout does not survive a reload
- **WHEN** a rule body calls `setTimeout(fn, 20 * 60 * 1000)` and the file is edited and reloaded 5 minutes later
- **THEN** `fn` from the old version never runs

#### Scenario: Module-level timer variable
- **WHEN** a rule file keeps a timer handle in a module-level variable and calls `clearTimeout` on it inside a rule body
- **THEN** the timer is cancelled as in plain JavaScript

### Requirement: User teardown hook
A rule SHALL be able to register teardown callbacks (via a free SDK function, or by returning a function from a setup function). They SHALL run when the rule is unloaded, before automatic cleanup.

#### Scenario: Returned teardown function runs
- **WHEN** a setup function returns a function and the rule is unloaded
- **THEN** the returned function is called once

#### Scenario: Teardown error is contained
- **WHEN** a teardown callback throws
- **THEN** the error is logged, the remaining teardown callbacks and automatic cleanup still run, and the engine continues

### Requirement: Error isolation
An exception thrown or a promise rejected inside a rule body, a setup function or any rule callback SHALL be caught and logged with the rule ID and stack trace. It SHALL NOT crash the engine, unload other rules, or disarm the failing rule's triggers.

#### Scenario: Body throws
- **WHEN** a rule body throws `TypeError`
- **THEN** the error is logged with the rule ID and stack trace, and the body still runs on the next trigger

#### Scenario: Setup throws
- **WHEN** a setup function throws
- **THEN** the rule is marked as failed, its partially registered resources are released, and other rules in the same file still start

#### Scenario: Unhandled rejection in rule code
- **WHEN** rule code starts a promise without awaiting it and that promise rejects
- **THEN** the engine logs the rejection, attributed to the rule where possible, and keeps running

### Requirement: Hot reload of changed files
The engine SHALL watch the rules directory. When a rule file is added, changed or removed, it SHALL unload all rules of the affected files and load them again from the new content, without restarting the process. It SHALL debounce bursts of file events.

#### Scenario: File edited
- **WHEN** the user saves a modification to `lights.ts`
- **THEN** all rules from `lights.ts` are unloaded and reloaded from the new content, and rules from other files are untouched

#### Scenario: File deleted
- **WHEN** `lights.ts` is deleted
- **THEN** all rules from `lights.ts` are unloaded and no longer listed

#### Scenario: Helper module edited
- **WHEN** `_lib/helpers.ts` changes and `hallway.ts` and `porch.ts` import it (directly or indirectly)
- **THEN** the rules from `hallway.ts` and `porch.ts` are reloaded

#### Scenario: Burst of saves
- **WHEN** an editor writes the same file three times within 200 ms
- **THEN** the affected rules are reloaded once

#### Scenario: Broken edit keeps nothing running
- **WHEN** a saved edit introduces a syntax error
- **THEN** the file's previous rules are unloaded, the error is logged, and the rules load again once the file is fixed

### Requirement: Hot reload can be disabled
Hot reload SHALL be enabled by default and SHALL be disableable through configuration, for environments where file watching is undesirable.

#### Scenario: Watch disabled
- **WHEN** hot reload is disabled and a rule file changes
- **THEN** the engine does not reload any rule until restart

### Requirement: File watching mode
The engine SHALL use native file-system notifications (inotify) to watch the rules directory. When native watching cannot be set up (e.g. unsupported file system, inotify watch limit reached), it SHALL fall back to polling and log a warning with the reason. `WATCH_POLL=true` SHALL force polling, and `WATCH_POLL=false` SHALL disable the fallback. Polling SHALL detect changes within 2 seconds.

#### Scenario: Native watching available
- **WHEN** `WATCH_POLL` is `auto` and native watching of the rules directory succeeds
- **THEN** the engine uses native notifications and does not poll

#### Scenario: Automatic fallback to polling
- **WHEN** `WATCH_POLL` is `auto` and setting up native watching fails with an inotify watch-limit error
- **THEN** the engine logs a warning naming the reason, switches to polling, and still reloads a changed rule file within 2 seconds

#### Scenario: Polling forced
- **WHEN** `WATCH_POLL=true` (e.g. on a Docker Desktop or network-share mount where native events are silently lost)
- **THEN** the engine polls the rules directory and reloads changed rule files within 2 seconds

#### Scenario: Fallback disabled
- **WHEN** `WATCH_POLL=false` and native watching cannot be set up
- **THEN** the engine logs an error that hot reload is unavailable and continues running the loaded rules without reloading

### Requirement: Disable rules via configuration
The engine SHALL accept a configured list of rule ID patterns (glob syntax on rule IDs) to disable. Matching rules SHALL be registered but not started, regardless of their options.

#### Scenario: Disable a whole file
- **WHEN** the disabled list contains `lights/*`
- **THEN** no rule whose ID starts with `lights/` is started

### Requirement: Rule status tracking
The engine SHALL track each rule's status (`running`, `disabled`, `failed`), the time of its last load, its last run time, and the last error message for failed rules or bodies. It SHALL track each file's load status and error.

#### Scenario: Failed rule reported
- **WHEN** a setup function failed
- **THEN** the rule's status is `failed` and its last error message is available to the health endpoint
