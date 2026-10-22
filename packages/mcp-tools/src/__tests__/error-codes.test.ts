// The published error-code inventory must cover EVERY code the framework
// emits — in BOTH directions.
//
// `MCP_ERROR_CODES` exists so a consumer that explains error codes to an
// agent (the `explain_error` discovery tool) can assert that every code it
// can receive has an explanation. The inventory used to be IMPLICIT — the
// codes were scattered across the middleware as string literals — so
// `explain_error` answered "UNKNOWN_ERROR_CODE" for codes the server had
// just produced.
//
// The published inventory fixed the explanation side, but the guard that
// keeps it honest was ONE-WAY (published → explained). That direction can
// only detect a code that was ADDED to the inventory; it can never detect a
// code that is EMITTED without being added — which is the failure the
// inventory exists to prevent. Six codes were in exactly that state
// (INVALID_INPUT, INTERNAL_ERROR, SERVICE_UNAVAILABLE, REFERENCE_ERROR,
// DATABASE_ERROR, DATABASE_CONNECTION_ERROR).
//
// This test closes that direction by scanning the package's own source for
// the `code: "…"` literals it emits.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_ERROR_CODES } from "../error-codes.js";
import { DOMAIN_ERROR_CODES } from "@besterp/shared";

const PACKAGE_SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every `.ts` file under `src/`, excluding the test files themselves. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("MCP_ERROR_CODES — the published inventory is complete", () => {
  it("covers every error code the package emits", () => {
    const published = new Set<string>([...MCP_ERROR_CODES, ...DOMAIN_ERROR_CODES]);
    const emitted = new Map<string, string>();

    for (const file of collectSourceFiles(PACKAGE_SRC)) {
      const source = readFileSync(file, "utf8");
      // `code: "SOMETHING"` — the shape every ToolResult error uses.
      for (const match of source.matchAll(/\bcode:\s*"([A-Z][A-Z0-9_]*)"/g)) {
        const code = match[1]!;
        if (!emitted.has(code)) emitted.set(code, file);
      }
    }

    const missing = [...emitted.keys()].filter((code) => !published.has(code));
    expect(
      missing,
      `these codes are emitted but not published: ${missing.map((c) => `${c} (${emitted.get(c)})`).join(", ")}`,
    ).toEqual([]);
  });

  it("publishes every code it claims to publish exactly once", () => {
    const unique = new Set(MCP_ERROR_CODES);
    expect(unique.size).toBe(MCP_ERROR_CODES.length);
  });
});
