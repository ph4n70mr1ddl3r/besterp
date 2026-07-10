# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-10. This is review round 9;
rounds 1–8 are documented in earlier revisions of this file and `CHANGES.md`.

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

1. **🟡 `sanitize.ts` — CSI ANSI escape regex omitted parameter byte range
   0x3C–0x3F (`< = > ?`).** The first ANSI branch stripped CSI (Control Sequence
   Introducer) sequences of the form `ESC [ parameters final-byte`. ECMA-48
   defines parameter bytes as the range 0x30–0x3F — digits, `:`, `;`, `<`, `=`,
   `>`, `?`. The regex used `[0-9;]*` which covered digits and `;` but missed
   `<`, `=`, `>`, `?`. Real-world sequences like `ESC [?25h` (show cursor),
   `ESC [?25l` (hide cursor), `ESC [?1049h` (enable alt buffer), and `ESC [>1;2c`
   (secondary device attributes) therefore fell through — the `ESC` initiator was
   replaced by the control-char pass, but the trailing parameter bytes and final
   byte survived as junk (`"[?25h"`). Fixed to `[\x30-\x3F]*` so the full ECMA-48
   parameter byte range is covered. Regression tests added for cursor show/hide,
   alt-buffer, and `>`-prefixed CSI sequences.

2. **🟢 Error-handler middleware — `sanitizeContextValueForToolResult` returned
   `{}` for DomainErrors with no context.** `handleDomainError` unconditionally
   assigned `context: sanitizeContextValueForToolResult(error.context)` to the
   `ToolResult.error`. For DomainErrors constructed without a `context` option,
   `error.context` is an empty object `{}`. `sanitizeContextValue({})` returned
   `{}`, which then passed through `sanitizeContextValueForToolResult` as a
   non-null object, yielding `context: {}` on every error response. This added
   noise to every error payload. Added an `Object.keys(obj).length === 0` guard
   in `sanitizeContextValueForToolResult` so empty context objects produce
   `context: undefined`, which is omitted from the JSON response. Tests added
   covering the empty-context and populated-context paths.

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
- `error-handler.ts` sanitizeContextValue Multibyte-safe string slicing with
  continuation-byte walk-back, Map/Set circular-reference detection, WeakMap/WeakSet
  fallthrough, and the MAX_SANITIZE_DEPTH guard.
- `audit-log.ts` redactSensitiveFields depth tracking across Map/Set/Array branches,
  SENSITIVE_FIELD_PATTERN lookup boundaries, and the redact-before-truncate order.
- `party-tools.ts` Zod schema builders (sanitizedString, uuidParam, optionalIsoDate)
  and superRefine cross-field validation.
- `discovery-tools.ts` runtime Prisma delegate validation and type-table mapping.

## Recommendation
No further changes required from this pass. The two fixes above are covered by
tests (+9 tests: shared +5, mcp-tools +4); all quality gates (typecheck, lint,
test) remain green.
