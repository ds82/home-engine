// Entity and service typing. Both interfaces are empty here; `home-engine typegen` emits a
// declaration file that augments them with the IDs of your Home Assistant instance:
//
//   declare module "@home-engine/sdk" {
//     interface HassEntities { "light.kitchen": HassEntity<"on" | "off", { brightness?: number }>; }
//     interface HassServices { "light.turn_on": { brightness_pct?: number }; }
//   }
//
// Without that file, entity IDs and service names are plain strings.

/**
 * Entity IDs mapped to their state object type. Empty here; the declaration file that
 * `home-engine typegen` writes fills it with your entities (see the typings guide).
 * @category Types
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HassEntities {}

/**
 * Service names (`domain.service`) mapped to their service data. Empty here; the declaration
 * file that `home-engine typegen` writes fills it with your services (see the typings guide).
 * @category Types
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HassServices {}

/**
 * Home Assistant's context of a state change or event: what caused it, and who.
 * @category Types
 */
export interface HassContext {
  /** The context ID. Changes caused by the same action share it. */
  id: string;
  /** The context that caused this one, e.g. the automation run behind a service call. */
  parent_id: string | null;
  /** The Home Assistant user who caused it, if any. */
  user_id: string | null;
}

/**
 * A Home Assistant state object, as `getEntity()` returns it and state events carry it.
 * @category Types
 */
export interface HassEntity<
  S extends string = string,
  A extends Record<string, unknown> = Record<string, unknown>,
> {
  /** The entity ID, e.g. `light.kitchen`. */
  entity_id: string;
  /** The state value, e.g. `"on"` or `"21.5"`. Home Assistant states are always strings. */
  state: S;
  /** The entity's attributes, e.g. `brightness` or `unit_of_measurement`. */
  attributes: A;
  /** When the state value last changed (ISO 8601). Attribute changes leave it unchanged. */
  last_changed: string;
  /** When the state value or an attribute last changed (ISO 8601). */
  last_updated: string;
  /** Home Assistant's context of the last change. */
  context: HassContext;
}

type IsEmpty<T> = keyof T extends never ? true : false;

/**
 * A known entity ID: any string until typings are generated, then only real IDs.
 * @category Types
 */
export type EntityId =
  IsEmpty<HassEntities> extends true ? string : Extract<keyof HassEntities, string>;

/**
 * Glob over entity IDs, e.g. `light.*` or `sensor.*_temperature`.
 * @category Types
 */
export type EntityPattern = `${string}*${string}`;

/**
 * What triggers accept: an entity ID or a glob pattern.
 * @category Types
 */
export type EntitySelector = EntityId | EntityPattern;

/**
 * The state object type of an entity ID (generic `HassEntity` when unknown).
 * @category Types
 */
export type EntityOf<Id> = Id extends keyof HassEntities
  ? HassEntities[Id] extends HassEntity
    ? HassEntities[Id]
    : HassEntity
  : HassEntity;

/**
 * A known service name: `domain.service`, narrowed once typings are generated.
 * @category Types
 */
export type ServiceName =
  IsEmpty<HassServices> extends true ? `${string}.${string}` : Extract<keyof HassServices, string>;

/**
 * Service data for a service name (any object when unknown).
 * @category Types
 */
export type ServiceData<S> = S extends keyof HassServices
  ? HassServices[S]
  : Record<string, unknown>;

/**
 * Where a service call is aimed.
 * @category Service calls & writes
 */
export interface ServiceTarget {
  /** One or more entities. */
  entity_id?: EntityId | EntityId[];
  /** One or more devices, by their device ID. */
  device_id?: string | string[];
  /** One or more areas, by their area ID. */
  area_id?: string | string[];
  /** One or more labels, by their label ID. */
  label_id?: string | string[];
}
