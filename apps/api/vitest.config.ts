import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The workspace packages publish their BUILD output (`dist/`), so the
// compiled API can resolve them at runtime. The tests, however, must always
// run against the SOURCE — otherwise a developer who edits
// `packages/shared/src` and runs the API's test suite would silently test a
// stale build. These aliases point the workspace specifiers back at the
// sources.
const workspaceAlias = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@besterp/shared": workspaceAlias("shared"),
      "@besterp/mcp-tools": workspaceAlias("mcp-tools"),
      "@besterp/database": workspaceAlias("database"),
    },
  },
  test: {
    include: ["src/**/*.spec.ts"],
    testTimeout: 10_000, // Prevent hanging tests on async operations
    hookTimeout: 10_000,
  },
});
