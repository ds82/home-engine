// Sun events and helpers (rule-scheduler: Sun events, Sun state helpers; design D6). Times
// come from suncalc for the Site's coordinates, one local day at a time. Days without the
// event (polar day or night) are skipped and logged at debug level, and so are missed runs
// (see LATE_LIMIT_MS).

import type { SunEventName } from "@home-engine/sdk";
import { getPosition, getTimes } from "suncalc";
import { parseDuration } from "./duration.js";
import type { Logger } from "./logger.js";
import { startsOnTime, type Clock } from "./timer.js";
import type { TriggerSource } from "./trigger-source.js";

export interface Location {
  latitude: number;
  longitude: number;
  elevation: number;
}

const DAY = 86_400_000;
/** Sun altitude at sunrise/sunset in suncalc (degrees, including refraction). */
const HORIZON = -0.833;

/** The instant of local noon on the local day containing `at` (good enough to pick the day). */
export function localNoon(at: number, timeZone: string | undefined): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const sinceMidnight =
    ((parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)) * 1000;
  return at - sinceMidnight + 12 * 3_600_000;
}

/** The event's time on the local day containing `at`, or undefined if it does not happen. */
export function sunEventOn(
  event: SunEventName,
  at: number,
  location: Location,
  timeZone: string | undefined,
): number | undefined {
  const times = getTimes(
    new Date(localNoon(at, timeZone)),
    location.latitude,
    location.longitude,
    location.elevation,
  );
  const value = times[event];
  return value ? value.getTime() : undefined;
}

/** Next occurrence (with offset) strictly after `after`, searching up to a year ahead. */
export function nextSunEvent(
  event: SunEventName,
  after: number,
  location: Location,
  timeZone: string | undefined,
  offsetMs = 0,
): number | undefined {
  for (let day = 0; day <= 366; day++) {
    const time = sunEventOn(event, after + day * DAY, location, timeZone);
    if (time !== undefined && time + offsetMs > after) {
      return time + offsetMs;
    }
  }
  return undefined;
}

export function isSunUpAt(at: number, location: Location): boolean {
  const altitude =
    (getPosition(new Date(at), location.latitude, location.longitude).altitude * 180) / Math.PI;
  return altitude > HORIZON;
}

export interface SunOptions {
  clock: Clock;
  timeZone: () => string | undefined;
  location: () => Location | undefined;
  onSiteChange?: (listener: () => void) => () => void;
  log?: Logger;
}

export interface SunHelpers {
  isSunUp(): boolean;
  isAfterSunset(): boolean;
  isBeforeSunrise(): boolean;
  nextSun(event: SunEventName): Date | undefined;
}

export function createSun(options: SunOptions): { source: TriggerSource; helpers: SunHelpers } {
  const { clock, timeZone, location } = options;

  const requireLocation = (fn: string): Location => {
    const loc = location();
    if (!loc) {
      throw new Error(`${fn}() needs the location from Home Assistant, which is not known yet`);
    }
    return loc;
  };

  const helpers: SunHelpers = {
    isSunUp: () => isSunUpAt(clock.now(), requireLocation("isSunUp")),
    isAfterSunset: () => {
      const loc = requireLocation("isAfterSunset");
      const now = clock.now();
      const sunset = sunEventOn("sunset", now, loc, timeZone());
      return sunset === undefined ? !isSunUpAt(now, loc) : now >= sunset;
    },
    isBeforeSunrise: () => {
      const loc = requireLocation("isBeforeSunrise");
      const now = clock.now();
      const sunrise = sunEventOn("sunrise", now, loc, timeZone());
      return sunrise === undefined ? !isSunUpAt(now, loc) : now < sunrise;
    },
    nextSun: (event) => {
      const at = nextSunEvent(event, clock.now(), requireLocation("nextSun"), timeZone());
      return at === undefined ? undefined : new Date(at);
    },
  };

  const source: TriggerSource = (trigger, context) => {
    if (trigger.kind !== "sun") {
      throw new Error(`sun source cannot arm ${trigger.kind}`);
    }
    const offsetMs = trigger.offset === undefined ? 0 : parseOffset(trigger.offset);
    const label = `sun(${JSON.stringify(trigger.event)})`;
    let cancel: () => void = () => {};
    let stopped = false;
    let pending: number | undefined;

    /** Arms the next firing, or a re-check at the next local day if today has none. */
    const arm = (after: number): void => {
      cancel();
      cancel = () => {};
      pending = undefined;
      const loc = location();
      if (!loc || stopped) {
        return;
      } // armed again when the Site becomes known
      const tz = timeZone();
      for (const day of [0, 1]) {
        const time = sunEventOn(trigger.event, after + day * DAY, loc, tz);
        if (time === undefined) {
          options.log?.debug(
            {
              event: trigger.event,
              day: new Date(localNoon(after + day * DAY, tz)).toISOString().slice(0, 10),
            },
            `No ${trigger.event} on this day at the configured location; skipping`,
          );
          // Look again on the following day.
          const recheck = localNoon(after + (day + 1) * DAY, tz) - 12 * 3_600_000;
          cancel = clock.setTimeout(() => arm(clock.now()), Math.max(0, recheck - clock.now()));
          return;
        }
        const at = time + offsetMs;
        if (at > after) {
          pending = at;
          cancel = clock.setTimeout(() => {
            if (stopped) {
              return;
            }
            const now = clock.now();
            if (startsOnTime(at, now, label, context.scope.log)) {
              context.fire({ type: "sun", event: trigger.event, scheduledAt: new Date(at) });
            }
            arm(now);
          }, at - clock.now());
          return;
        }
      }
    };

    arm(clock.now());
    const offSite = options.onSiteChange?.(() => arm(clock.now()));
    return {
      nextRun: () => (stopped || pending === undefined ? undefined : new Date(pending)),
      dispose: () => {
        stopped = true;
        cancel();
        offSite?.();
      },
    };
  };

  return { source, helpers };
}

/** Sun offsets may be negative: "-30m", "+15m", or milliseconds. */
export function parseOffset(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const match = /^\s*([+-]?)\s*(.+)$/.exec(value);
    if (match?.[2]) {
      const sign = match[1] === "-" ? -1 : 1;
      try {
        return sign * parseDuration(match[2]);
      } catch {
        // fall through to the error below
      }
    }
  }
  throw new TypeError(`Invalid sun offset: ${JSON.stringify(value)} (use e.g. "-30m" or "+15m")`);
}
