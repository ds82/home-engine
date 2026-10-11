// Compiles only if event narrowing works; every @ts-expect-error must hit an error.
import {
  listen,
  rule,
  setup,
  type CronTrigger,
  type EntityId,
  type EntitySelector,
  type EventTrigger,
  type ServiceName,
  type StartupTrigger,
  type StateTrigger,
} from "@home-engine/sdk";

const motion: StateTrigger = { kind: "state", entities: ["binary_sensor.hall_motion"] };
const nightly: CronTrigger = { kind: "cron", expression: "0 22 * * *" };
const startup: StartupTrigger = { kind: "startup" };
const zha: EventTrigger = { kind: "event", eventType: "zha_event" };

rule("narrowing", [motion, nightly], (event) => {
  if (event.type === "state") {
    const id: string = event.entityId;
    const value: string | undefined = event.to?.state;
    const engine: boolean = event.causedByEngine;
    const flags: boolean = event.resynced || event.restored;
    void [id, value, engine, flags];
  } else {
    const at: Date = event.scheduledAt;
    // @ts-expect-error -- entityId only exists on state events
    void event.entityId;
    void at;
  }
  // @ts-expect-error -- outside the branch the event may be a time event
  void event.entityId;
  // @ts-expect-error -- this rule has no bus-event trigger, so "event" is impossible
  if (event.type === "event") return;
  const signal: AbortSignal = event.signal;
  void signal;
});

rule("single trigger", zha, (event) => {
  const type: "event" = event.type;
  const data: Record<string, unknown> = event.data;
  void [type, data];
});

rule("startup and state", [startup, motion], (event) => {
  if (event.type === "startup") return;
  const id: string = event.entityId;
  void id;
});

rule("options", motion, () => {}, { mode: "queued", max: 5, id: "hall-motion" });

setup("setup rule", () => {
  const handle = listen(motion, (event) => {
    const id: string = event.entityId;
    void id;
  });
  handle.cancel();
  return () => {};
});

// @ts-expect-error -- setup rules take no concurrency mode
setup("no mode", () => {}, { mode: "single" });

// Without generated typings, IDs and services are plain strings.
const anyEntity: EntityId = "anything.at_all";
const glob: EntitySelector = "light.*";
const anyService: ServiceName = "notify.telegram";
// @ts-expect-error -- service names need a domain
const badService: ServiceName = "no_domain";
void [anyEntity, glob, anyService, badService];
