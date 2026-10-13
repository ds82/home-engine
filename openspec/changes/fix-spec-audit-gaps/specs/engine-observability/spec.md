# Spec Delta

## MODIFIED Requirements

### Requirement: Rule status endpoint
The engine SHALL serve `GET /rules`. It SHALL return a JSON list of all known rules with ID, source file, status (`starting`, `running`, `disabled`, `failed`), last load time, last error message, and the number of active triggers and scheduled timers. Triggers that Home Assistant rejected SHALL be listed with their error, their position in the rule's trigger list and a short description of the trigger, while the rule keeps status `running`.

#### Scenario: Failed rule listed
- **WHEN** a rule failed during setup with `ReferenceError: foo is not defined`
- **THEN** `GET /rules` lists it with status `failed` and that error message

#### Scenario: Rejected trigger identified
- **WHEN** a rule has two `onTrigger` triggers and Home Assistant rejects the second one
- **THEN** `GET /rules` lists the rule as `running` with one trigger error that names position 2 and the trigger's platform, together with Home Assistant's message
