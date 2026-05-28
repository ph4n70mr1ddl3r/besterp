import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    testTimeout: 10_000, // Prevent hanging tests on async operations
    hookTimeout: 10_000,
  },
});
