// Turns Home Assistant's `get_states` and `get_services` results into a declaration file that
// augments `@home-engine/sdk` (rule-files: Generated Home Assistant typings; design D12).
// The output is deterministic (sorted, no timestamps) so it can be committed and diffed.

/** The parts of a state object typegen reads. */
export interface StateInput {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

/** `get_services`: domain → service → description with field selectors. */
export type ServicesInput = Record<string, Record<string, { fields?: Record<string, unknown> }>>;

export interface TypingsInput {
  states: readonly StateInput[];
  services: ServicesInput;
  /** Home Assistant version, for the header comment. */
  version?: string;
}

/** Domains whose entities are on or off (or unavailable/unknown). */
const ON_OFF_DOMAINS = new Set([
  "binary_sensor",
  "fan",
  "input_boolean",
  "light",
  "remote",
  "siren",
  "switch",
]);

const STATE_UNIONS: Record<string, readonly string[]> = {
  cover: ["open", "opening", "closed", "closing"],
  lock: ["locked", "locking", "unlocked", "unlocking", "jammed", "open", "opening"],
  person: [],
  sun: ["above_horizon", "below_horizon"],
};

const quote = (text: string): string => JSON.stringify(text);
const union = (values: readonly string[]): string => values.map(quote).join(" | ");

/** The TypeScript type of an attribute's current value. */
function valueType(value: unknown): string {
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "unknown[]";
  if (value !== null && typeof value === "object") return "Record<string, unknown>";
  return "unknown";
}

function stateType(entityId: string): string {
  const domain = entityId.split(".")[0] ?? "";
  if (ON_OFF_DOMAINS.has(domain)) return union(["on", "off", "unavailable", "unknown"]);
  const known = STATE_UNIONS[domain];
  if (known?.length) return union([...known, "unavailable", "unknown"]);
  return "string";
}

function attributesType(attributes: Record<string, unknown>, indent: string): string {
  const keys = Object.keys(attributes).sort();
  const lines = keys.map((key) => `${indent}  ${quote(key)}?: ${valueType(attributes[key])};`);
  return ["{", ...lines, `${indent}  [key: string]: unknown;`, `${indent}}`].join("\n");
}

/** The TypeScript type of a service field, from its selector. */
function selectorType(field: Record<string, unknown>): string {
  const selector = field.selector;
  if (typeof selector !== "object" || selector === null) return "unknown";
  const [kind, config] = Object.entries(selector)[0] ?? [];
  const options = (config as { options?: unknown } | null)?.options;
  const multiple = (config as { multiple?: unknown } | null)?.multiple === true;
  const one = ((): string => {
    switch (kind) {
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "text":
      case "template":
      case "time":
      case "date":
      case "datetime":
      case "icon":
      case "area":
      case "device":
      case "floor":
      case "label":
        return "string";
      case "entity":
        return "string | string[]";
      case "color_rgb":
        return "[number, number, number]";
      case "color_temp":
        return "number";
      case "duration":
        return "string | number | { hours?: number; minutes?: number; seconds?: number }";
      case "object":
        return "unknown";
      case "select": {
        if (!Array.isArray(options) || options.length === 0) return "string";
        const values = options.map((o: unknown) =>
          typeof o === "object" && o !== null ? String((o as { value: unknown }).value) : String(o),
        );
        return union([...new Set(values)]);
      }
      default:
        return "unknown";
    }
  })();
  return multiple && !one.includes("|") ? `${one}[]` : one;
}

/** Fields of a service, flattening collapsible sections (`advanced_fields`). */
function serviceFields(fields: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  return Object.entries(fields).flatMap(([name, value]) => {
    const field = (value ?? {}) as Record<string, unknown>;
    if (typeof field.fields === "object" && field.fields !== null && !("selector" in field)) {
      return serviceFields(field.fields as Record<string, unknown>);
    }
    return [[name, field] as [string, Record<string, unknown>]];
  });
}

function serviceDataType(fields: Record<string, unknown>, indent: string): string {
  const lines = serviceFields(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, field]) =>
        `${indent}  ${quote(name)}${field.required === true ? "" : "?"}: ${selectorType(field)};`,
    );
  if (!serviceFields(fields).some(([name]) => name === "entity_id")) {
    lines.push(`${indent}  "entity_id"?: string | string[];`);
  }
  return ["{", ...lines, `${indent}}`].join("\n");
}

/** The declaration file text. */
export function generateTypings(input: TypingsInput): string {
  const states = [...input.states].sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  const domains = [
    ...new Set([
      ...states.map((s) => s.entity_id.split(".")[0] ?? ""),
      ...Object.keys(input.services),
    ]),
  ]
    .filter(Boolean)
    .sort();
  const services = Object.entries(input.services)
    .flatMap(([domain, byName]) =>
      Object.entries(byName).map(([name, description]) => ({
        name: `${domain}.${name}`,
        fields: description.fields ?? {},
      })),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const entityLines = states.map(
    (s) =>
      `    ${quote(s.entity_id)}: HassEntity<${stateType(s.entity_id)}, ${attributesType(s.attributes, "    ")}>;`,
  );
  const serviceLines = services.map(
    (s) => `    ${quote(s.name)}: ${serviceDataType(s.fields, "    ")};`,
  );

  return [
    "// Generated by home-engine typegen" +
      (input.version ? ` from Home Assistant ${input.version}` : "") +
      ". Do not edit; run typegen again after adding entities or integrations.",
    'import type { HassEntity } from "@home-engine/sdk";',
    "",
    'declare module "@home-engine/sdk" {',
    "  interface HassEntities {",
    ...entityLines,
    "  }",
    "",
    "  interface HassServices {",
    ...serviceLines,
    "  }",
    "",
    "  /** The domains of this Home Assistant instance. */",
    `  type HassDomain = ${domains.length ? union(domains) : "never"};`,
    "}",
    "",
  ].join("\n");
}
