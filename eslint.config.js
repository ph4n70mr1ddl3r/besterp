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
            "packages/mcp-tools/src/__tests__/*.ts",
            "packages/shared/src/__tests__/*.ts",
          ],
        },
      },
    },
    rules: {
      // Enforce strict TypeScript
      "@typescript-eslint/no-explicit-any": "warn",
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
      "packages/database/prisma/seed.ts",
      "packages/mcp-tools/spikes/",
    ],
  },
);
