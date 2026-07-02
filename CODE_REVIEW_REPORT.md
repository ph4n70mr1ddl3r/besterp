# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-02. This is review round 8;
rounds 1–7 are documented in `CHANGES.md`.

## Baseline
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — clean across all workspaces
- `npm run test` — all passing (database, mcp-tools, shared, api)

## Areas Reviewed
- **Sanitization & security:** `sanitize.ts` (HTML/entity/control-char stripping,
  log-injection defenses, ANSI handling), `sanitizeLogOutput`, `safeFromCodePoint`.
- **Idempotency:** `idempotency.ts` race-free acquire (serializable txn + P2034
  retry), hash determinism (`crypto.ts` key sorting incl. Map/Set), throw/soft-failure
  message capping.
- **Truncation:** `truncate.ts` payload capping, `safeSliceUtf8` multibyte handling.
- **Auth & multi-tenancy:** JWT strategy/guard, tenant guard, RLS proxy
  (`rls-extension.ts`), `PrismaService` tenant-client cache + FinalizationRegistry.
- **HTTP bootstrap:** `main.ts` env validation, graceful shutdown, CORS, the
  `x-request-id` correlation middleware, body-size limits, error-handling order.
- **Domain layer:** `PartyService` validation/sanitization defense-in-depth,
  DTOs (`party.dto.ts`), MCP Zod schemas (`party-tools.ts`).
- **Tool framework:** registry, tool-definition types, error-handler middleware,
  `pluralize`, Prisma-error mapping.

## Findings & Actions

### Fixed this round

1. **🟡 `sanitize.ts` — non-CSI ANSI escape regex omitted lowercase final bytes.**
   `sanitizeForLog`'s third ANSI branch documented itself as "ESC followed by a
   final byte" but its character class excluded lowercase letters (`a`–`z`,
   0x61–0x7A). Real two-character ESC sequences with lowercase finals therefore
   fell through: `ESC c` (RIS — full terminal reset), `ESC n` (LS2), `ESC o` (LS3).
   The ESC initiator is *always* neutralized by the subsequent control-char pass,
   so this was not an active terminal-control security hole — but the trailing
   final byte survived as a stray character (`"\x1bc"` → `"_c"` instead of `""`),
   leaving junk in sanitized log lines. Added `a-z` to the class so the full
   ECMA-48 final-byte range (0x30–0x7E) is covered, with a comment explaining the
   nuance. Regression tests added for RIS/LS2/LS3 including an explicit guard
   that the output is not the old `"_c"` shape.

2. **🟡 `main.ts` — untrusted `x-request-id` reflected into a response header
   without charset validation.** The correlation middleware only ran
   `raw.slice(0, 128)` on the client-supplied header before reflecting it via
   `res.setHeader("x-request-id", …)` and storing it on `req.requestId` for
   downstream logging. Raw CRLF is already gated by Node's HTTP parser +
   `setHeader` validation, so this was not an exploitable response-splitting bug —
   but spaces, tabs, non-ASCII bytes, and multi-valued (array) headers were
   accepted verbatim and flowed into both the response header and log correlation.
   Extracted a pure, tested `resolveRequestId(raw)` helper
   (`apps/api/src/common/request-id.ts`) that honours the header only when it is a
   printable-ASCII token (0x21–0x7E, no whitespace/control bytes, ≤128 chars) and
   falls back to a fresh UUID v4 otherwise. Covered by 12 unit tests (valid UUID /
   ULID / traceparent / base64 passthrough, trim, empty/array/non-string → UUID,
   CRLF/NUL/ESC rejection, non-ASCII rejection, boundary length).

3. **🟢 Test: locked in untested `crypto.ts` behavior.** The non-trivial
   `sortKeysDeep` paths for `Map`/`Set` (canonical sorted-key/value conversion)
   and the `MAX_HASH_DEPTH` DoS guard had no direct coverage. Added tests for
   Map key-order independence, Set value-order independence, distinct-content
   differentiation, and the depth-limit throw (`InvalidTypeValueError` /
   "maximum nesting depth").

### Reviewed and considered sound (no change needed)

- `stripHtmlTags` decode/strip loop, DoS caps (`MAX_INPUT_LENGTH`,
  `MAX_SANITIZE_ITERATIONS`), entity-decoding order, and C0/DEL stripping.
- Idempotency acquire/reset state machine, the serializable-transaction race
  guard (P2034-only retry is correct: under SERIALIZABLE the create path cannot
  surface P2002), and the unreachable-by-design failed-with-matching-hash fallback.
- Audit-log backpressure manager: slot accounting, queue timeout/unref, drop
  counters, and the double-redaction elimination.
- RLS proxy blocked-method sets, LRU delegate/method caches, `$transaction`
  interception, and the `FinalizationRegistry` race guards in `PrismaService`.
- JWT secret resolution/caching, tenant/agent ID trimming consistency across
  the JWT strategy, tenant guard, and `McpModule.buildContext`.
- Error-handler Prisma-code mapping (`P2002/P2003/P2025/P2034`),
  `pluralize` (verified `party`→`parties`, `entity`→`entities`, `address`→`addresses`),
  and hallucination-resistant tool suggestion in the registry.
- `truncate.ts` `safeSliceUtf8` continuation-byte walk-back (consistent across
  `capString` and `_preview`).
- `crypto.ts` circular-reference detection and `Object.create(null)` prototype
  pollution defense.

## Recommendation
No further changes required from this pass. The two completeness/defense-in-depth
fixes above are covered by tests (+16 tests: shared +4, api +12); all quality
gates (typecheck, lint, test) remain green.
