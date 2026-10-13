# Health and status

The engine serves three read-only JSON endpoints on `HTTP_PORT`:

- `GET /health/live`: 200 while the event loop responds; the container health check uses it.
- `GET /health/ready`: 200 once the engine is connected to Home Assistant and has loaded the
  rule files. Rule statuses do not affect it.
- `GET /rules`: every rule with its file, status, last load and run, last error, active
  triggers, pending timers and next run.

A rule's `status` is one of:

| Status     | Meaning                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `starting` | A setup rule whose async setup function has not finished yet; its listeners already fire.         |
| `running`  | Started and armed.                                                                                |
| `disabled` | Switched off by `enabled: false` or `DISABLED_RULES`.                                             |
| `failed`   | Its setup failed or timed out. `lastError` keeps the error name: `ReferenceError: foo is not ...` |

A trigger Home Assistant rejects does not stop the rule: it stays `running`, and
`triggerErrors` lists each rejected trigger as `{ kind, position, trigger, message }`.
`position` counts from 1 in the rule's trigger list (or the listener's, in a setup rule), and
`trigger` describes it briefly, e.g. `ha-trigger numeric_state`.
