// The app-local error-code guard: the same idea as the package-level
// `error-codes.test.ts` in `@besterp/mcp-tools` (scan emitted `code: "…"`
// literals, assert every one is published), pointed at `apps/api` so a new
// code emitted by an API-level tool or middleware cannot ship unexplained.
//
// The scan is restricted to the MCP tool surface (`src/mcp/**`): those are
// the codes an agent can actually receive. Everything else in the app
// (NestJS controllers, domain services) emits Prisma/domain error objects,
// not `code: "…"` result envelopes.
//
// The published inventories come from `MCP_ERROR_CODES` + `DOMAIN_ERROR_CODES`
// (union of both). Two codes are intentionally APP-LOCAL and not in either
// inventory — they are asserted here instead:
//   - `UNKNOWN_ERROR_CODE` — emitted by `explain_error` when a requested code
//     has no explanation entry. It is a self-referential, app-local code, and
//     it MUST stay in the `ERROR_EXPLANATIONS` table (which it does), so an
//     agent that hits it gets guidance instead of looping on a code with none.
//   - `"custom"` — the Zod issue code on schema validation failures
//     (`ctx.addIssue({ code: "custom" })` in `party-tools.ts`), not an error
//     code an agent sees (the result envelope's code is `INVALID_INPUT`).
//     Matched by the same regex the package-level guard uses, so it is listed
//     here to keep that regex honest against this directory.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_ERROR_CODES } from "@besterp/mcp-tools";
import { DOMAIN_ERROR_CODES } from "@besterp/shared";

const MCP_DIR = fileURLToPath(new URL("../mcp", import.meta.url));

const LOCAL_CODES = new Set(["UNKNOWN_ERROR_CODE", "custom"]);

/** Every `.ts` file under `apps/api/src/mcp/`, excluding the spec files. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("apps/api MCP error codes — every emitted code is explained or local", () => {
  it("covers every error code the MCP tool surface emits", () => {
    const published = new Set<string>([...MCP_ERROR_CODES, ...DOMAIN_ERROR_CODES, ...LOCAL_CODES]);
    const emitted = new Map<string, string>();

    for (const file of collectSourceFiles(MCP_DIR)) {
      const source = readFileSync(file, "utf8");
      // `code: "SOMETHING"` — the shape every ToolResult error uses.
      for (const match of source.matchAll(/\bcode:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
        const code = match[1]!;
        if (!emitted.has(code)) emitted.set(code, file);
      }
    }

    const missing = [...emitted.keys()].filter((code) => !published.has(code));
    expect(
      missing,
      `these codes are emitted by apps/api but not published or explained: ${missing.map((c) => `${c} (${emitted.get(c)})`).join(", ")}`,
    ).toEqual([]);
  });

  it("the app-local UNKNOWN_ERROR_CODE has an explanation entry", () => {
    // The self-referential entry is asserted here in the package that owns it,
    // so removing the table entry (or renaming the constant) fails this suite.
    expect(LOCAL_CODES.has("UNKNOWN_ERROR_CODE")).toBe(true);
    // discovery-tools.ts carries the table; assert the source still has an
    // entry for the constant so a future refactor cannot silently drop it.
    const source = readFileSync(join(MCP_DIR, "tools", "discovery-tools.ts"), "utf8");
    expect(source).toContain("UNKNOWN_ERROR_CODE");
    expect(source).toMatch(/\[UNKNOWN_ERROR_CODE\]:\s*\{/);
  });
});
