import { describe, expect, it } from "vitest";
import { describeError } from "./errors.js";

describe("describeError", () => {
  it("keeps the error name, except for plain errors and messages that start with it", () => {
    expect(describeError(new ReferenceError("foo is not defined"))).toBe(
      "ReferenceError: foo is not defined",
    );
    expect(describeError(new Error("boom"))).toBe("boom");
    const named = new TypeError("TypeError in the message");
    expect(describeError(named)).toBe("TypeError in the message");
    expect(describeError("a string")).toBe("a string");
    expect(describeError(42)).toBe("42");
  });
});
