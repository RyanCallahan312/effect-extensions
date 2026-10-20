import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      thresholds: { branches: 90, functions: 95, lines: 95, statements: 95 },
    },
    include: ["test/**/*.test.ts"],
  },
});
