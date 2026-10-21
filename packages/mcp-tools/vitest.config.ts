import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The workspace packages publish their BUILD output (`dist/`); the tests
// always run against the SOURCE (see apps/api/vitest.config.ts).
const workspaceAlias = (name: string): string =>
  fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@besterp/shared": workspaceAlias("shared"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
