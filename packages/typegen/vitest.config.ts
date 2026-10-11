import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "typegen",
    include: ["src/**/*.test.ts"],
  },
});
