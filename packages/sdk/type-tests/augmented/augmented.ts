// With generated typings present, entity IDs and services are narrowed.
import type {
  EntityId,
  EntityOf,
  EntitySelector,
  HassEntity,
  ServiceData,
  ServiceName,
} from "@home-engine/sdk";

declare module "@home-engine/sdk" {
  interface HassEntities {
    "light.kitchen": HassEntity<"on" | "off", { brightness?: number }>;
    "sensor.temperature": HassEntity<string, { unit_of_measurement: "°C" }>;
  }
  interface HassServices {
    "light.turn_on": { brightness_pct?: number };
  }
}

const known: EntityId = "light.kitchen";
// @ts-expect-error -- unknown entity IDs are rejected once typings exist
const unknown: EntityId = "light.does_not_exist";
const pattern: EntitySelector = "light.*";

type KitchenState = EntityOf<"light.kitchen">["state"];
const on: KitchenState = "on";
// @ts-expect-error -- the generated state type only allows on/off
const dimmed: KitchenState = "dimmed";

const service: ServiceName = "light.turn_on";
// @ts-expect-error -- unknown services are rejected once typings exist
const missing: ServiceName = "light.does_not_exist";
const data: ServiceData<"light.turn_on"> = { brightness_pct: 50 };
// @ts-expect-error -- service data is typed per service
const wrongData: ServiceData<"light.turn_on"> = { brightness_pct: "high" };

void [known, unknown, pattern, on, dimmed, service, missing, data, wrongData];
