// Entity and service typing. Both interfaces are empty here; `home-engine typegen` emits a
// declaration file that augments them with the IDs of your Home Assistant instance:
//
//   declare module "@home-engine/sdk" {
//     interface HassEntities { "light.kitchen": HassEntity<"on" | "off", { brightness?: number }>; }
//     interface HassServices { "light.turn_on": { brightness_pct?: number }; }
//   }
//
// Without that file, entity IDs and service names are plain strings.

/** Entity IDs mapped to their state object type. Augmented by generated typings. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HassEntities {}

/** Service names (`domain.service`) mapped to their service data. Augmented by generated typings. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HassServices {}

export interface HassContext {
  id: string;
  parent_id: string | null;
  user_id: string | null;
}

/** A Home Assistant state object, as `getEntity()` returns it and state events carry it. */
export interface HassEntity<
  S extends string = string,
  A extends Record<string, unknown> = Record<string, unknown>,
> {
  entity_id: string;
  state: S;
  attributes: A;
  last_changed: string;
  last_updated: string;
  context: HassContext;
}

type IsEmpty<T> = keyof T extends never ? true : false;

/** A known entity ID: any string until typings are generated, then only real IDs. */
export type EntityId =
  IsEmpty<HassEntities> extends true ? string : Extract<keyof HassEntities, string>;

/** Glob over entity IDs, e.g. `light.*` or `sensor.*_temperature`. */
export type EntityPattern = `${string}*${string}`;

/** What triggers accept: an entity ID or a glob pattern. */
export type EntitySelector = EntityId | EntityPattern;

/** The state object type of an entity ID (generic `HassEntity` when unknown). */
export type EntityOf<Id> = Id extends keyof HassEntities
  ? HassEntities[Id] extends HassEntity
    ? HassEntities[Id]
    : HassEntity
  : HassEntity;

/** A known service name: `domain.service`, narrowed once typings are generated. */
export type ServiceName =
  IsEmpty<HassServices> extends true ? `${string}.${string}` : Extract<keyof HassServices, string>;

/** Service data for a service name (any object when unknown). */
export type ServiceData<S> = S extends keyof HassServices
  ? HassServices[S]
  : Record<string, unknown>;

/** Where a service call is aimed. */
export interface ServiceTarget {
  entity_id?: EntityId | EntityId[];
  device_id?: string | string[];
  area_id?: string | string[];
  label_id?: string | string[];
}
