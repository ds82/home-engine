import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";

describe("parseDuration", () => {
  it.each([
    [1500, 1500],
    [0, 0],
    ["500ms", 500],
    ["30s", 30_000],
    ["5m", 300_000],
    ["1h30m", 5_400_000],
    ["1d", 86_400_000],
    ["1.5s", 1_500],
    [" 2m ", 120_000],
  ])("%j is %d ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(["5 minutes", "", "m5", "5x", "1h 30m", -1, Number.NaN, null, {}])(
    "rejects %j and names it",
    (input) => {
      expect(() => parseDuration(input, "sleep() duration")).toThrow(/Invalid sleep\(\) duration/);
    },
  );
});
