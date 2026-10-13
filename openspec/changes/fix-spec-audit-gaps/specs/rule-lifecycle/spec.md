# Spec Delta

## MODIFIED Requirements

### Requirement: File evaluation is atomic
A rule file SHALL be evaluated once per load. Its rules SHALL start only after evaluation (including top-level `await`) completes successfully. If evaluation throws or rejects, none of the rules the file registered SHALL start, and the file SHALL be reported as failed with the error.

#### Scenario: Error after some registrations
- **WHEN** a file registers two rules and then throws at top level
- **THEN** neither rule starts, the file is reported as failed with the error and stack trace, and other files are unaffected

#### Scenario: Evaluation timeout
- **WHEN** a file's top-level evaluation does not settle within 30 seconds
- **THEN** the engine logs a warning naming the file, marks it as failed, and releases anything it registered

#### Scenario: Timed-out file keeps running
- **WHEN** a file timed out during evaluation and its top-level code later calls `rule()` or starts a timer while another file is being evaluated
- **THEN** the `rule()` call throws, the timer is cancelled, and nothing is attributed to the other file

### Requirement: Rule start
After successful file evaluation, the engine SHALL start each enabled rule: for triggered rules it arms the triggers, and for setup rules it calls the setup function once. In both cases pending holds are restored (see rule-triggers). Setup functions MAY be async. A setup rule counts as running when its returned promise (if any) resolves; until then its status SHALL be `starting`.

#### Scenario: Async setup
- **WHEN** a setup rule is `async` and awaits a service call before registering listeners
- **THEN** the engine awaits it, reports the rule as `starting` while the promise is pending, and marks the rule as running once the promise resolves

#### Scenario: Setup timeout
- **WHEN** a setup function's promise does not settle within 30 seconds
- **THEN** the engine logs a warning naming the rule, marks it as failed, and disposes any resources it registered so far

### Requirement: Rule status tracking
The engine SHALL track each rule's status (`starting`, `running`, `disabled`, `failed`), the time of its last load, its last run time, and the last error message for failed rules or bodies. It SHALL track each file's load status and error. Error messages SHALL include the error's name, as in `ReferenceError: foo is not defined`.

#### Scenario: Failed rule reported
- **WHEN** a setup function failed
- **THEN** the rule's status is `failed` and its last error message is available to the health endpoint

#### Scenario: Error name kept
- **WHEN** a setup function throws `ReferenceError: foo is not defined`
- **THEN** the rule's last error message is `ReferenceError: foo is not defined`
