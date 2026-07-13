# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-13. This is review round 25;
rounds 1–24 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 137, mcp-tools 117, database (RLS tests
  skipped without a live DB), api 302

## Findings & Actions

### Fixed this round

1. **🟡 `sensitive-fields.ts` — redaction bypass for `dateOfBirth`,
   `passcode`, `passphrase`.** The camelCase date-of-birth variant
   `dateOfBirth` was NOT detected even though `birthDate`, `birth_date`,
   `date_of_birth`, and `dob` all were — an inconsistency that left DOB
   (sensitive PII) unredacted under that specific key. The auth-secret
   names `passcode` and `passphrase` were not detected by any layer
   (neither the explicit set, the `SENSITIVE_FIELD_PATTERN` regex — whose
   `password` branch requires the full word — nor the `SENSITIVE_TOKENS`
   fallback). An MCP tool input like `{ dateOfBirth: "1990-01-01" }` or
   `{ passcode: "1234" }` would have been persisted verbatim to
   `ai_action_log.tool_input` and surfaced in `ToolResult.error.context`.
   Fixed by adding `dateOfBirth`, `passcode`, `passphrase` to
   `SENSITIVE_FIELDS`, and `passcode`, `passphrase` to `SENSITIVE_TOKENS`
   (which catches camelCase variants like `newPasscode`,
   `verifyPassphrase`, `passcodeVerify`, and `passcode_hash`). The DOB
   fix uses the explicit-set approach rather than adding a `birth` token,
   because `birth` is too broad and would over-redact benign ERP fields
   like `birthRate` (demographic stats) — confirmed by a new
   non-over-redaction assertion. Added regression tests for the new fields
   and a dedicated "all DOB variants" consistency test.

2. **🟢 `cleanup-expired-idempotency.ts` — misleading usage comment.**
   The header usage example read `DATABASE_URL="..." npx tsx ...` but the
   script gates on `DATABASE_ADMIN_URL` (the app role can't see
   tenant-scoped expired records through RLS). A copy-paste from the
   comment would exit with `DATABASE_ADMIN_URL is required`. Fixed the
   comment to reference the correct variable.

### New tests added
- `sensitive-fields.test.ts` — 2 new test blocks (passcode/passphrase +
  camelCase variants; all-DOB-variants consistency) plus 2 new
  non-over-redaction assertions (`birthRate`, `birthday`). File now has 18
  tests (was 16).

## Recommendation
All fixes are covered by tests (all quality gates green). Remaining
observations are low-severity and do not require immediate code changes:

- `hashInput` has no input size limit (mitigated by the 100 KB body-parser cap
  and per-field Zod `.max()` limits). The `MAX_HASH_DEPTH` recursion cap
  bounds stack depth, and the body cap bounds serialized size in practice.
- `redactKey` in `idempotency.ts` only sanitizes (strips control chars) the
  first 32 chars of the idempotency key rather than masking it; the name is
  slightly misleading but the behaviour is intentional for debugging, and
  idempotency keys are opaque caller-supplied dedup tokens, not secrets.

## Resolved candidates
- ~~`sensitive-fields.ts` missing OTP/MFA~~ — addressed in round 22
- ~~`sensitive-fields.ts` missing `dateOfBirth`/`passcode`/`passphrase`~~ —
  addressed in round 25
- ~~`error-handler.ts` `sanitizeContextValue` did not redact by field name~~ —
  addressed in round 21 (`DomainError.context` now applies the same
  key-based `isSensitiveField` redaction as the audit-log, via the shared
  `middleware/sensitive-fields.ts` module).

---

## Round 22 (earlier review, retained for history)

### Scope
Full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) — review round 22.

## Findings & Actions

### Fixed this round

1. **🟡 `sensitive-fields.ts` — OTP/MFA fields missing from redaction lists.**
   `SENSITIVE_FIELDS` and `SENSITIVE_TOKENS` did not include `otp`, `mfa`,
   `otp_code`, `one_time_password`, or `mfa_secret`. Bare `otp` is not caught
   by `SENSITIVE_FIELD_PATTERN` (no matching regex branch), and the token-based
   fallback splits it to `["otp"]` which wasn't in `SENSITIVE_TOKENS`. An MCP
   tool input like `{ otp: "123456" }` would be persisted verbatim to
   `ai_action_log.tool_input`. Fixed by adding the OTP/MFA fields to both
   `SENSITIVE_FIELDS` and `SENSITIVE_TOKENS`, and applying `Object.freeze()`
   to both sets for runtime immutability. Added a dedicated
   `sensitive-fields.test.ts` (16 tests) covering explicit names, OTP/MFA
   fields, snake/camelCase detection, benign-field non-over-redaction,
   `splitFieldTokens`, set contents, regex patterns, and freeze assertions.

2. **🟡 `idempotency.ts` — hash of invalid input caused false mismatch on retry.**
   When `safeParse` failed, the middleware hashed the raw (un-normalised) input.
   A subsequent retry with valid (Zod-transformed) input produced a different
   hash, causing `IDEMPOTENCY_KEY_MISMATCH` instead of allowing the retry.
   Fixed by skipping idempotency entirely on validation failure — no record
   is created, so a retry starts fresh. Added a regression test.

3. **🟡 `party.service.ts` — belt-and-suspenders guard against `Invalid Date`.**
   `new Date(sanitizedPerson.birthDate)` could produce an `Invalid Date` if a
   future call path bypasses `requireValidDate`. Added `isNaN(getTime())`
   guards that throw `InvalidTypeValueError` with the invalid value.

4. **🟢 `rls-extension.ts` — non-function properties returned `undefined`.**
   The proxy's `get` trap returned `undefined` for non-function model
   properties instead of the actual value. Fixed to `return originalFn`.

5. **🟢 `truncate.ts` — Date objects silently type-changed to string.**
   `Date` → `JSON.stringify` → `JSON.parse` produced a plain string. Added
   explicit `Date` handling that converts to ISO string directly. Extracted
   `normalisePrimitive` helper to keep complexity within lint threshold.

6. **🟢 `error-handler.ts` — explicit return type on `handlePrismaError`.**
   Added `PrismaErrorResult | null` annotation for type safety.

### New tests added
- `sensitive-fields.test.ts` — 16 tests (new file)
- `middleware.test.ts` — 7 new tests (P2028, P2024, Map/Set context, unrecognized Prisma code, idempotency skip-on-invalid)
- `truncate.test.ts` — 1 new test (Date handling)

## Recommendation
All fixes are covered by tests (all quality gates green). Remaining
observations are low-severity and do not require immediate code changes:

- `hashInput` has no input size limit (mitigated by the 100 KB body-parser cap
  and per-field Zod `.max()` limits). The `MAX_HASH_DEPTH` recursion cap
  bounds stack depth, and the body cap bounds serialized size in practice.
- The two retained complexity lint warnings reflect intentional, well-commented
  branching and would require splitting cohesive functions purely to satisfy
  the metric.

## Resolved candidates
- ~~`sensitive-fields.ts` missing OTP/MFA~~ — addressed in round 22
- ~~`error-handler.ts` `sanitizeContextValue` did not redact by field name~~ —
  addressed in round 21 (`DomainError.context` now applies the same
  key-based `isSensitiveField` redaction as the audit-log, via the shared
  `middleware/sensitive-fields.ts` module).
