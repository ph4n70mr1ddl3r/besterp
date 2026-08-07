import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "packages/database/src/__tests__/*.ts",
            "packages/database/prisma/*.ts",
            "packages/database/scripts/*.ts",
            "packages/database/spikes/*.ts",
            "packages/mcp-tools/src/__tests__/*.ts",
            "packages/shared/src/__tests__/*.ts",
            "apps/api/vitest.config.ts",
            "packages/database/vitest.config.ts",
            "packages/mcp-tools/vitest.config.ts",
            "packages/shared/vitest.config.ts",
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
      },
    },
    rules: {
      // Enforce strict TypeScript
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-require-imports": "error",

      // Catch accidentally unhandled promises (fire-and-forget is explicitly
      // used in audit-log middleware and idempotency middleware, but any
      // other forgotten await should be flagged).
      "@typescript-eslint/no-floating-promises": "error",

      // General code quality
      "no-console": "off", // Allow console in server code
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-throw-literal": "error",
      "prefer-const": "error",
      "no-var": "error",

      // Complexity limits
      "max-lines-per-function": ["warn", { max: 120, skipBlankLines: true, skipComments: true }],
      "max-nested-callbacks": ["warn", { max: 4 }],
      "max-depth": ["warn", { max: 4 }],
      complexity: ["warn", { max: 15 }],
    },
  },
  {
    files: ["**/*.spec.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "max-lines-per-function": "off",
      "max-nested-callbacks": "off",
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "**/dist/",
      "**/*.js",
      "**/*.d.ts",
      "packages/database/prisma/migrations/",
      "packages/database/spikes/",
      "**/spikes/",
    ],
  },
);
