// Durations (rule-scheduler: Durations): milliseconds as a number, or a string such as
// "500ms", "30s", "5m", "1h30m" or "1d". Malformed values throw at the call site.

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Converts a duration to milliseconds. Throws for malformed or negative values. */
export function parseDuration(value: unknown, what = "duration"): number {
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) return value;
    throw new TypeError(`Invalid ${what}: ${value} (expected milliseconds >= 0)`);
  }
  if (typeof value === "string") {
    const text = value.trim();
    const part = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
    let total = 0;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = part.exec(text)) !== null) {
      total += Number(match[1]) * (UNITS[match[2] as string] ?? 0);
      consumed = part.lastIndex;
    }
    if (text !== "" && consumed === text.length) return total;
  }
  throw new TypeError(
    `Invalid ${what}: ${JSON.stringify(value)} (use milliseconds or e.g. "500ms", "30s", "5m", "1h30m", "1d")`,
  );
}
