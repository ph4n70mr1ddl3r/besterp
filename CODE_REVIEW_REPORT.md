# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-02. This is review round 7;
rounds 1–6 are documented in `CHANGES.md`.

## Baseline
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — clean across all workspaces
- `npm run test` — all passing (database, mcp-tools, shared, api)

## Areas Reviewed
- **Sanitization & security:** `sanitize.ts` (HTML/entity/control-char stripping,
  log injection defenses, ANSI handling, DoS caps), `audit-log.ts` redaction +
  backpressure, `domain-exception.filter.ts` production scrubbing.
- **Idempotency:** `idempotency.ts` race-free acquire (serializable txn + retry),
  hash determinism (`crypto.ts` key sorting), throw/soft-failure message capping.
- **Truncation:** `truncate.ts` payload capping for JSONB columns.
- **Auth & multi-tenancy:** JWT strategy/guard, tenant guard, RLS proxy
  (`rls-extension.ts`) including `$transaction` interception and tenant-client
  caching/eviction.
- **Domain layer:** `PartyService` validation/sanitization defense-in-depth,
  DTOs (`party.dto.ts`), MCP Zod schemas (`party-tools.ts`).
- **Tool framework:** registry, tool-definition types, error-handler middleware.

## Findings & Actions

### Fixed this round

1. **🟡 UTF-8 multibyte split in stored previews (`truncate.ts`).**
   `truncateValue()`'s `_preview` used a naive byte slice that could split a
   multi-byte character and emit a spurious U+FFFD into durable
   `ai_action_log` / `idempotency_record` previews. `capString()` in the same
   file already handled this correctly. Extracted a shared `safeSliceUtf8()`
   helper used by both, plus a `truncationMarker()` builder. Added 16 direct
   unit tests (`truncate.test.ts`), including deterministic multibyte-boundary
   cases verified to fail against the old naive slice.

### Reviewed and considered sound (no change needed)

- `stripHtmlTags` decode/strip loop, DoS caps (`MAX_INPUT_LENGTH`,
  `MAX_SANITIZE_ITERATIONS`), and `safeFromCodePoint` surrogate/range handling.
- Idempotency acquire/reset state machine and the (unreachable-by-design)
  failed-with-matching-hash fallback.
- Audit-log backpressure manager: slot accounting, queue timeout/unref, and
  drop counters are internally consistent.
- RLS proxy blocked-method sets, LRU delegate/method caches, and the
  `FinalizationRegistry` race guards in `PrismaService`.
- JWT secret resolution/caching, tenant/agent ID trimming consistency across
  the JWT strategy, tenant guard, and `McpModule.buildContext`.
- Error-handler Prisma-code mapping (`P2002/P2003/P2025/P2034`) and
  hallucination-resistant tool suggestion in the registry.

## Recommendation
No further changes required from this pass. The single correctness fix above is
covered by tests; all quality gates (typecheck, lint, test) remain green.
