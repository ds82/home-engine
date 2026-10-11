import { describe, expect, it } from "vitest";
import { onStartup } from "./trigger-constructors.js";

describe("onStartup", () => {
  it("returns a frozen startup descriptor", () => {
    const trigger = onStartup();
    expect(trigger).toEqual({ kind: "startup" });
    expect(Object.isFrozen(trigger)).toBe(true);
  });

  it("rejects arguments", () => {
    expect(() => (onStartup as (...a: unknown[]) => unknown)("x")).toThrow(/takes no arguments/);
  });
});
