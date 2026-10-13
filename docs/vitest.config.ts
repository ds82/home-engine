import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "docs",
    include: ["test/**/*.test.ts"],
  },
});
