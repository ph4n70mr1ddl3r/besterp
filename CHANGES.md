# BestERP — Security & Architecture Fixes

## Changes Applied (2026-07-12) — Code Review Round 21

### 🟢 Defense-in-depth: `error-handler.ts` — `DomainError.context` was not redacted by field name (secret-named keys could reach the AI agent)

**Problem:** The error-handler middleware sanitises `DomainError.context` before returning it to the AI agent via `sanitizeContextValue`, but that pass only scrubs string *values* (URL/path redaction + control-char stripping) — it does **not** redact by *field name*. The sibling audit-log middleware (`redactSensitiveFields`) does both. So the two agent-facing surfaces applied different redaction postures: a `password`/`apiKey`/`clientSecret` placed in a `DomainError`'s `context` would be persisted to the audit row as `[REDACTED]` but returned to the agent in the `ToolResult.error.context` verbatim. `DomainError.context` is application-constructed and by design never carries raw user secrets, so this was not an active leak — but it was the exact defense-in-depth gap the round-20 report called out as a candidate ("a future DomainError that places a secret in `context` would surface it to the AI agent").

**Fix:** The sensitive-field detection (`isSensitiveField` + its `SENSITIVE_FIELDS` set, `SENSITIVE_FIELD_PATTERN` regex, and `SENSITIVE_TOKENS`/`splitFieldTokens` camelCase fallback) is now shared between the two middlewares via a new `middleware/sensitive-fields.ts` module — a behaviour-preserving extraction (the audit-log imports it instead of defining it locally). The error-handler's `sanitizeObject` now redacts any value whose key `isSensitiveField` marks sensitive to `[REDACTED]`, before the value-level URL/path scrub runs, so both surfaces apply identical key-based redaction. Verified by probe that **none** of the 34 field names actually used across every existing `DomainError` call site (`partyId`, `field`, `conflictingFields`, `prismaCode`, `email`, `invalidValue`, `originalInputHash`, `requestedTool`, …) is flagged sensitive, so the change is behaviour-preserving in practice — it only closes the future-leak gap. Added regression tests asserting sensitive-named keys (`password`, `apiKey`, `api_key`, `accessToken`, `clientSecret`) are redacted while benign diagnostic fields pass through, that the raw secrets never reach the agent, and that URL/path scrubbing on non-sensitive values still composes correctly.

## Changes Applied (2026-07-12) — Code Review Round 20

### 🟡 Correctness: `idempotency.ts` — wasted all retries + backoff latency when the idempotency record expired mid-operation (P2025)

**Problem:** After a tool completes, `updateIdempotencyRecordWithRetry` persists the result by updating the pending record. If the 24h-TTL cleanup job (or a concurrent reset) removed the row between acquire and update, the update throws Prisma `P2025` ("record to update not found"). Because `P2025` was not special-cased, the loop retried it `IDEMPOTENCY_MAX_RETRIES` times — every retry re-throws `P2025` since the row is gone permanently — burning `IDEMPOTENCY_RETRY_BASE_DELAY_MS * (1+2) = 150 ms` of backoff before throwing `ConcurrencyConflictError`. That error was then swallowed by both call sites in `executeAndUpdate` (the success path and the throw path each wrap the call in `try/catch` + `logIdempotencyWarn`), so the only observable effect was wasted latency and a misleading "could not be updated after N attempts" warning that blamed retries for an unrecoverable condition.

**Fix:** `P2025` is now detected on the first attempt and short-circuits — log once (explaining the expiry, not blaming retries) and return, since there is nothing to update and both callers already tolerate a non-throwing return. Other transient errors keep the existing retry-then-throw behaviour. Verified the regression test fails on the pre-fix code (3 update attempts + propagated `ConcurrencyConflictError`) and passes on the fix (1 attempt, result returned). Also merged two adjacent `if (code !== "P2034")` blocks in `acquireIdempotencyRecord`'s catch into one (identical condition, behaviour-preserving).

### 🟡 Correctness: `party.service.ts` — duplicate-email redaction was malformed for short local parts

**Problem:** `checkEmailDuplicate` masks the offending address before putting it in the `DuplicateEntityError` message + `context`. The preview was computed as `${email.slice(0, 2)}***@${domain}` unconditionally. For a valid address with a single-character local part (`a@x.com` — accepted by `EMAIL_REGEX`), the 2-char slice spans into the `@`, producing `a@***@x.com` — a malformed address emitted to the AI agent and stored in the structured error context. Confirmed by probe: `"a@x.com"` → `"a@***@x.com"`. This path was previously untested.

**Fix:** The preview is now clamped to `slice(0, Math.min(2, atIdx))` so the `@` never lands inside it. Behaviour is unchanged for local parts ≥ 2 chars (`ab@x.com` → `ab***@x.com`); the 1-char case is now `a***@x.com`. Added a regression test that exercises `emailAddress.findFirst` returning an existing match and asserts the redacted shape, the absence of the malformed double-`@`, and that the full unmasked address never reaches the error surface. Verified the test fails on the pre-fix code.

## Changes Applied (2026-07-11) — Code Review Round 14

### 🟡 Security: `audit-log.ts` — camelCase sensitive fields leaked past catch-all redaction regex (redaction bypass)

**Problem:** `SENSITIVE_FIELD_PATTERN` uses alnum-only lookarounds (`(?<![a-zA-Z0-9])` / `(?![a-zA-Z0-9])`) so `_` and `-` act as separators, but the lowercase→uppercase transition does **not**. The snake_case siblings were redacted (`client_secret`, `bearer_token`, `access_token`) while their camelCase forms — `clientSecret`, `bearerToken`, `accessToken`, `refreshToken`, `userPassword`, `sessionToken` — leaked verbatim into `ai_action_log.tool_input`. Confirmed by probe: `isSensitiveField("clientSecret")` returned `false` while `isSensitiveField("client_secret")` returned `true`. These are common OAuth/credential field names, so the gap was a real redaction bypass on a durable, cross-tenant audit table. The code comment even claimed camelCase was caught, but the implementation only delivered that for `auth`-prefixed names (`authToken`) via the dedicated `auth(?:token|key|code|…)?` branch.

**Fix:** Added a token-based fallback to `isSensitiveField`. `splitFieldTokens()` splits a field name at snake_case, kebab-case, **and** camelCase boundaries (`clientSecret` → `[client, Secret]`), then each token is checked against `SENSITIVE_TOKENS` (`password`, `passwd`, `pwd`, `secret`, `token`, `credential`, `credentials`). `key` is intentionally excluded — it over-redacts benign names like `primaryKey`/`foreignKey`/`sortKey`; key-bearing sensitive fields stay covered by the explicit `SENSITIVE_FIELDS` set and the `api[_-]?key` regex. None of the current party-tool field names (`idempotencyKey`, `lineNumber`, `birthDate`, `partyType`, …) contain a sensitive token, so there is no over-redaction in practice. Added a regression test in `middleware.test.ts` asserting the camelCase forms are redacted, their snake_case siblings stay redacted, and `primaryKey`/`foreignKey`/`idempotencyKey`/`tokenize`/`secrets` are preserved.

### 🟡 Security: `sanitize.ts` — credential-bearing URLs with unlisted schemes leaked to operator logs

**Problem:** `sanitizeLogOutput` had explicit patterns for `postgres(ql)://`, `redis://`, `mongodb://`, `mysql://`, `amqp(s)://`, `http(s)://`, `ftp/sftp://`, and `ws/wss://`, but no catch-all for other schemes. A driver/library error can embed a credential-bearing URL in any scheme — e.g. `ssh://user:pass@host`, `ldap://cn=admin:password@host`, `vault://token:s3cret@host` — and these passed through verbatim, leaking inline credentials to stderr/audit logs. Confirmed by probe: all three were returned unchanged.

**Fix:** Added a generic credential-URL pattern `[a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@"']+:[^\s/@"']+@[^\s"']+` → `[REDACTED_URL]`, placed **after** the scheme-specific patterns so they keep their labelled output (`[DATABASE_URL]`, `[REDIS_URL]`, …) and this only catches what they miss. The pattern requires a userinfo segment (`user:pass@`), so credential-free URLs of arbitrary schemes (`file:///etc/passwd`, `custom://host`) are not false positives. Added regression tests in `sanitize.test.ts` covering `ssh`/`ldap`/`ldaps`/`vault` schemes, mid-sentence credentials, the no-false-positive case, and labelled-output preservation.

## Changes Applied (2026-07-11) — Code Review Round 13

### 🟡 Correctness: `crypto.ts` — `hashInput` silently hashed WeakMap/WeakSet as `{}` (hash collision)

**Problem:** `sortKeysDeep` has explicit branches for `Map` and `Set` (converted to sorted arrays) and throws for `function` values, but no branch for `WeakMap`/`WeakSet`. These are non-enumerable, so they fell through `sortObject` → `serializeSpecialObject` → `sortPlainObject`, where `Object.keys()` returns `[]`. Result: `hashInput(new WeakMap())` produced the **same hash as `hashInput({})`** (and every distinct WeakMap collided with every other) — confirmed by probe. That is silent data loss for an idempotency hash: two tool inputs differing only in an unhashable Weak collection would be treated as identical, defeating mismatch detection. Both `audit-log.ts` and `error-handler.ts` already guard Weak collections (`"[WeakCollection]"`), making this an inconsistency.

**Fix:** Added a guard in `serializeSpecialObject` (the non-plain-object dispatch point that Weak collections actually reach — `WeakMap.prototype`/`WeakSet.prototype` are neither `Object.prototype` nor `null`, so they bypass `sortPlainObject`'s direct path) that throws `InvalidTypeValueError`, mirroring the existing `function` guard. The guard lives there rather than in `sortKeysDeep` so the latter keeps its prior cyclomatic complexity (no new lint warning). Added a regression test in `crypto.test.ts` asserting `hashInput` throws for a bare `WeakMap`/`WeakSet`, for one nested inside an object, and that a plain `{}` still hashes successfully.

### 🟡 Security: `audit-log.ts` — `redactSensitiveFields` returned raw unredacted value past depth cap (redaction bypass)

**Problem:** `isTerminal` short-circuited to `true` when `depth > MAX_REDACTION_DEPTH`, and `redactSensitiveFields` then `return value` — the raw object. Because the key-name redaction loop runs *inside* `redactSensitiveFields` (after the terminal check), an object sitting deeper than the cap was returned whole with its sensitive keys never inspected: a `password` buried >10 levels deep would be persisted verbatim to `ai_action_log.tool_input`. The sibling `error-handler.ts` `sanitizeContextValue` returns `"[Too deep]"` at its cap; for a *redaction* function, returning unredacted data is the riskier choice.

**Fix:** Split the depth guard out of `isTerminal`: `redactSensitiveFields` now returns `"[Too deep]"` when `depth > MAX_REDACTION_DEPTH` (matching `sanitizeContextValue`), and `isTerminal` checks only primitive/terminal types. Added a regression test in `middleware.test.ts` that nests `{ password: "leak-me" }` 12 levels deep and asserts the serialized stored `toolInput` neither contains `"leak-me"` nor omits the `"[Too deep]"` placeholder. Verified the test fails on the pre-fix code (raw `"password":"leak-me"` in the stored row) and passes on the fix.

## Changes Applied (2026-07-11) — Code Review Round 12

### 🟡 Correctness: `main.ts` — JWT_SECRET weak-secret heuristic flagged legitimate high-entropy secrets (false positive)

**Problem:** The startup weak-secret check used the pattern `/^(0{32}|[a-f]{32})$/i`, documented as catching "all-same-case hex (no entropy)". But `[a-f]{32}` matches **any** 32-character string composed solely of `a–f` letters — e.g. `"abcdefabcdefabcdefabcdefabcdefab"` (~82 bits of entropy) — not just a single repeated character. An operator using a random 16-byte hex secret that happened to contain no digits received a spurious `JWT_SECRET appears to be a weak or default value` warning. Worse, because this logic lived inline in the bootstrap (which calls `process.exit`), it had no unit tests.

**Fix:** Extracted the heuristics into a standalone, testable module `apps/api/src/auth/secret-strength.ts` exporting `isWeakSecret()` and `MIN_JWT_SECRET_LENGTH`. Replaced the buggy pattern with `/^(.)\1{31,}$/`, which matches a single character repeated for the whole string — the correct expression of zero entropy (`0`×32, `f`×32, spaces, …) — without false-positiving on real hex secrets. `main.ts` now delegates to the helper. Added `secret-strength.spec.ts` with a regression test asserting that `"abcdef..."` (32 a–f letters) and a random 32-char hex are both classified as **not** weak, while all-zero / all-`f` / default literals are.

### 🟢 Consistency: `auth.module.ts` — `JWT_EXPIRES_IN` warning regex aligned with the authoritative startup gate

**Problem:** `auth.module.ts` validated `JWT_EXPIRES_IN` with `/^\d+\s*[smhd]$/` (optional whitespace), while `main.ts`'s `validateEnvironment()` enforces `/^\d+[smhd]$/` strictly and exits on mismatch. Because ESM module-level code evaluates before `main.ts` runs, the module-level warning is the first signal an operator sees; a divergent regex either warns about values the app accepts or stays silent about values the app rejects.

**Fix:** Dropped the `\s*` so the warning regex exactly mirrors the hard gate. The warning remains a best-effort preview (the authoritative exit happens in `main.ts`).

### 🟢 Log hygiene: `cleanup-expired-idempotency.ts` — removed emoji from structured stderr line

**Problem:** The failure log emitted `❌ Cleanup failed:` while every other structured log line across the middlewares and this script is plain ASCII. The leading emoji risked glyph/encoding surprises in log shippers that don't expect multi-byte symbols on the error stream.

**Fix:** Dropped the `❌` for consistency with the rest of the operator-log output.

## Changes Applied (2026-07-07) — Code Review Round 39

### 🟡 Security: `audit-log.ts` — snake_case sensitive fields leaked past catch-all redaction regex

**Problem:** `SENSITIVE_FIELD_PATTERN` used `\b` word boundaries: `/\b(password|secret|token|api[_-]?key|credential|auth(?:Token|Key|Code)?)\b/i`. Under JS regex, `_` is a word character (`\w` = `[A-Za-z0-9_]`), so there is **no word boundary** between `_` and an adjacent keyword. Consequently `\btoken\b` could not match `session_token`, `auth_token`, `bearer_token`, `id_token`, `user_token`, or `client_secret`, and the `auth` subgroup could not match `auth_token` / `auth_key` / `auth_code`. The explicit `SENSITIVE_FIELDS` set covered `access_token` / `refresh_token`, but every other `*_token` / `*_secret` / `auth_*` field name leaked into `ai_action_log.tool_input` verbatim. This is a real credential-leak surface: an MCP tool input like `{ auth_token: "eyJ..." }` or `{ client_secret: "..." }` would be persisted to the durable audit table unredacted.

**Fix:** Replaced the `\b` boundaries with alnum-only lookarounds (`(?<![a-z0-9])` / `(?![a-z0-9])`) so `_` and `-` act as separators, and extended the `auth` subgroup to accept a snake/camel `token|key|code` suffix:
`/(?<![a-z0-9])(password|secret|token|api[_-]?key|credential|auth(?:token|key|code|[_-](?:token|key|code))?)(?![a-z0-9])/i`.
This catches `auth_token`, `session_token`, `bearer_token`, `id_token`, `client_secret`, `user_token`, `auth_key`, `auth_code`, and `authToken`/`authKey` (camelCase) while still rejecting infix matches inside unrelated words (`tokenize`, `keywords`, …). Verified no over-redaction of the legitimate party/contact field names. Added a regression test asserting each snake_case variant is redacted and that `tokenize`/`name` are left intact.

### 🟡 Log hygiene: `prisma.service.ts` — DB connection errors logged with raw datasource URLs

**Problem:** `onModuleInit` (connect-failure catch) and `onModuleDestroy` (per-client disconnect rejection) wrote Prisma/driver error `message` and `stack` straight to the NestJS logger. Driver connection errors routinely embed the datasource URL (credentials + hostname, e.g. `postgres://besterp:s3cret@10.0.0.5:5432/besterp`), and `${result.reason}` stringifies an `Error` as `name: message`, so the URL reached operator logs verbatim. This was inconsistent with `main.ts` (shutdown paths), the global `DomainExceptionFilter`, and the MCP error-handler middleware, all of which scrub such messages via `sanitizeForLogOutput`.

**Fix:** Wrapped both log sites (message + stack in `onModuleInit`; reason in `onModuleDestroy`) with `sanitizeForLogOutput` so connection strings/hostnames/paths are redacted to `[DATABASE_URL]` / `[HOST]` / `[PATH]`. Added two regression tests that inject a URL-bearing connection error and assert the password and scheme never reach the log while `[DATABASE_URL]` does.

### 🟢 Log hygiene: `idempotency.ts` + `audit-log.ts` — driver errors in stderr warnings scrubbed

**Problem:** Two fire-and-forget stderr warning paths wrote raw driver error messages: (1) `acquireIdempotencyRecord`'s non-P2034 warning included `e.message`, and (2) `updateIdempotencyRecordWithRetry`'s final-attempt warning included raw `detail` (the thrown `InvalidTypeValueError` already sanitized the same detail, but the stderr line did not). Separately, the audit-log backpressure manager's `.catch` on a failed `aiActionLog.create` wrote `logErr.message` to stderr. All three can carry a DB connection string.

**Fix:** Applied `sanitizeLogOutput` to the embedded error message in each of the three warning sites, matching the audit-log error-persistence path (`executeAndLog`'s throw branch) and the error-handler middleware. Added regression tests: the idempotency acquire non-P2034 path and the audit-write failure path now inject a URL-bearing driver error and assert `[DATABASE_URL]` replaces it before it reaches stderr.

## Changes Applied (2026-07-03) — Code Review Round 17

### 🟢 Cleanup: `party-tools.ts` — Eliminated Double `trim()` Call in `optionalSanitizedString`

**Problem:** The `optionalSanitizedString` helper called `s.trim()` twice — once in the
truthiness check (`s?.trim()`) and again in the HTML-strip call (`stripHtmlTags(s.trim())`).
This was a minor performance waste and set a misleading pattern for future helpers.

**Fix:** Captured the trimmed result in a local variable so `.trim()` runs exactly once.

## Changes Applied (2026-07-02) — Code Review Round 8

### 🟡 Fix: `sanitize.ts` — non-CSI ANSI escape regex missed lowercase finals

**Problem:** `sanitizeForLog`'s third ANSI branch is documented as "ESC followed by a final byte" but its character class excluded lowercase letters (`a`–`z`, 0x61–0x7A). Real two-character ESC sequences with lowercase finals fell through — `ESC c` (RIS, full terminal reset), `ESC n` (LS2), `ESC o` (LS3). The ESC initiator is always neutralized by the subsequent control-char replacement pass, so this was **not** an active terminal-control security hole; the trailing final byte just survived as a stray character (`"\x1bc"` → `"_c"` instead of `""`), leaving junk in sanitized log lines.

**Fix:** Added `a-z` to the class so the full ECMA-48 final-byte range (0x30–0x7E) is covered. Added a comment explaining the nuance (the ESC byte is always stripped by the control-char pass, so this is a log-completeness fix, not a security fix). Added regression tests for RIS/LS2/LS3, including an explicit guard that the output is not the old `"_c"` shape.

### 🟡 Fix: `main.ts` — untrusted `x-request-id` reflected without charset validation

**Problem:** The request-correlation middleware only ran `raw.slice(0, 128)` on the client-supplied `x-request-id` header before reflecting it via `res.setHeader("x-request-id", …)` and storing it on `req.requestId`. Raw CRLF is already gated by Node's HTTP parser + `setHeader` validation, so this was not an exploitable response-splitting bug — but spaces, tabs, non-ASCII bytes, and multi-valued (array) headers were accepted verbatim and flowed into both the response header and log correlation.

**Fix:** Extracted a pure, tested `resolveRequestId(raw)` helper (`apps/api/src/common/request-id.ts`) that honours the header only when it is a printable-ASCII token (0x21–0x7E, no whitespace/control bytes, ≤128 chars) and falls back to a fresh UUID v4 otherwise. `main.ts` now delegates to it. Covered by 12 unit tests (valid UUID/ULID/traceparent/base64 passthrough, trim, empty/array/non-string → UUID, CRLF/NUL/ESC rejection, non-ASCII rejection, boundary length). Removed the now-unused `randomUUID` import from `main.ts`.

### 🟢 Test: locked in untested `crypto.ts` behavior (Map/Set + depth guard)

**Problem:** The non-trivial `sortKeysDeep` paths for `Map`/`Set` (canonical sorted-key/value conversion) and the `MAX_HASH_DEPTH` DoS guard had no direct coverage, so regressions in idempotency-hash determinism could slip through unnoticed.

**Fix:** Added tests in `crypto.test.ts` for Map key-order independence, Set value-order independence, distinct-content differentiation, and the depth-limit throw (`InvalidTypeValueError` / "maximum nesting depth"). Behavior is unchanged; these are pure coverage locks.

## Changes Applied (2026-07-02) — Code Review Round 7

### 🟡 Fix: `truncate.ts` — UTF-8 multibyte split in stored previews

**Problem:** `truncateValue()` (used by the audit-log and idempotency middlewares to cap JSONB payloads at 64 KB) generated its `_preview` via a naive `textDecoder.decode(encoded.slice(0, PREVIEW_BYTES))`. When the 1 KB preview boundary landed in the middle of a multi-byte UTF-8 character (CJK text, emoji, accented chars), `TextDecoder` emitted a spurious U+FFFD (replacement character) at the end of the stored preview. The sibling `capString()` in the *same file* already walked backwards over continuation bytes to avoid exactly this — so the two functions were inconsistent, and the durable `ai_action_log` / `idempotency_record` previews could silently contain corrupt trailing replacement characters.

**Fix:**
- Extracted a shared `safeSliceUtf8(encoded, byteLimit)` helper that walks back over UTF-8 continuation bytes (`10xxxxxx`, 0x80–0xBF) so a slice never ends mid-code-point.
- `capString()` now delegates to it (replacing its inline walk-back loop) and all four `_preview` sites in `truncateValue()` (string/boolean, number, bigint, and general-object branches) use it via a new `truncationMarker(encoded)` builder.
- Behaviour is otherwise identical; only the previously-broken previews change (they get one code point shorter instead of gaining a U+FFFD).

### 🟢 Test: New `truncate.test.ts` (16 tests)

**Problem:** `truncateValue` / `capString` had no direct unit coverage — they were only exercised indirectly through the middleware integration tests, and none of those covered the multibyte boundary.

**Fix:** Added `packages/mcp-tools/src/__tests__/truncate.test.ts` covering pass-through of primitives/null/undefined, bigint→string, symbol/function markers, oversize truncation markers, circular-reference error markers, and — critically — deterministic multibyte-boundary cases for both the `_preview` path and `capString`. The two preview cases are constructed so the byte cap lands on a known continuation byte; they fail against the old naive slice (verified by temporarily reverting) and pass with `safeSliceUtf8`.

## Changes Applied (2026-07-02) — Code Review Round 6

### 🟢 Cleanup: `mcp.module.ts` — Removed Duplicate `validateReasoningField`

**Problem:** `validateReasoningField` was byte-for-byte identical to `validateOptionalField` — same type guard, same trim, same whitespace-only rejection, same length cap, and the exact same error strings. The only difference was the hardcoded `"reasoning"` field name, which `validateOptionalField` already accepts as a parameter. ~33 lines of duplicated logic.

**Fix:** Deleted `validateReasoningField` and routed the `reasoning` field through `validateOptionalField("reasoning", overrides.reasoning, MAX_REASONING_LENGTH)`. All existing `mcp.module.spec.ts` assertions (type error, too-long, whitespace-only, trim, null→undefined, max-length) continue to pass unchanged.

### 🟢 Cleanup: `party-tools.ts` — Replaced Magic Numbers with Shared Pagination Constants

**Problem:** The `search_parties` Zod schema hardcoded `.min(1).max(500)` for `limit` and `.min(0)` for `offset`, while the sibling REST DTO (`party.dto.ts`) and the service layer (`party.service.ts`) both use the `MIN_SEARCH_LIMIT` / `MAX_SEARCH_LIMIT` / `MIN_SEARCH_OFFSET` constants from `@besterp/shared`. If the shared constant changes, the MCP schema would silently drift out of sync, accepting input the service then has to reject/clamp.

**Fix:** Imported the three constants and used them in both the validators and the AI-facing `.describe()` strings (`max ${MAX_SEARCH_LIMIT}`, `min ${MIN_SEARCH_OFFSET}`).

### 🟢 Cleanup: `party-tools.ts` — Extracted `uuidParam()` Helper

**Problem:** The `partyId` field `z.string().min(1).max(200).regex(UUID_REGEX, "Must be a valid UUID")` was duplicated verbatim across three tools (`get_party`, `add_party_role`, `add_contact_mechanism`).

**Fix:** Extracted a `uuidParam(description)` helper alongside the existing `sanitizedString` / `optionalIsoDate` builders, centralizing the UUID contract (including the 200-char generous input cap, documented inline) so it can't drift between tools.

### 🟡 Robustness: `domain-exception.filter.ts` — Generic Fallback Message for Scrubbed HttpExceptions

**Problem:** The production branch of `handleHttpException` only kept `res.message` when it was a string. `ValidationPipe` errors carry `message` as an **array** of detail strings, so in production a 400 returned a bare `{ statusCode: 400, error: "Bad Request" }` with no `message` field — useless to API clients trying to understand why their request was rejected.

**Fix:** When `res.message` is not a string, substitute a generic, status-appropriate message (`"Validation failed"` for 400, `"Request error"` otherwise). The security goal is preserved — internal field names from the validation detail array are still stripped — but clients now receive a usable body.

### 🟢 Test: Added `domain-exception.filter.spec.ts` (11 tests)

**Problem:** `DomainExceptionFilter` is a critical globally-registered component (maps every DomainError/HttpException/unexpected error to an HTTP response) yet had **zero** test coverage.

**Fix:** Added a focused spec covering: DomainError→status mapping (404/409/422), unknown-code 500 generic message, production scrubbing of `suggestedTools`/`context`, the new ValidationPipe array-message fallback, string-message pass-through, non-production pass-through, unexpected-error sanitization (verifies connection strings are redacted), and the headers-already-sent guard.

## Changes Applied (2026-07-02) — Code Review Round 5

### 🟢 Cleanup: `party-tools.ts` — Removed Duplicate `optionalSanitizedText` Helper

**Problem:** `optionalSanitizedText` was byte-for-byte identical to `optionalSanitizedString`. Its doc comment claimed a behavioral difference ("whitespace-only input becomes undefined"), but both functions already did this via the `s?.trim() ? ... : undefined` transform — so the second function was dead code with a misleading comment.

**Fix:**
- Removed `optionalSanitizedText` entirely
- Updated its 4 call sites (`addressLine2`, `stateProvince`, `extension`, `description`) to use `optionalSanitizedString`
- Folded the (accurate) whitespace-normalization note into `optionalSanitizedString`'s doc comment

### 🟢 Cleanup: `party-tools.ts` — Simplified `optionalIsoDate` Refine Predicate

**Problem:** The refine check `v === undefined || v.length > 0 && isValidISODate(v)` mixed `||` and `&&` without parentheses (a readability trap) and included a redundant `v.length > 0` — the preceding transform already converts empty/whitespace input to `undefined`, so any non-`undefined` `v` reaching the refine is guaranteed non-empty.

**Fix:** Simplified to `v === undefined || isValidISODate(v)` with a comment explaining why the length check is implicit. Behavior is identical.

### 🟢 Cleanup: `audit-log.ts` — Eliminated Double Redaction of `toolInput`

**Problem:** `redactSensitiveFields(entry.toolInput)` ran in `logAction()`, but `toolInput` had *already* been redacted by `createBaseEntry()` before it entered the backpressure queue. The second pass re-traversed the (potentially large) object graph for no effect, doubling redaction cost on every audited tool call.

**Fix:** `logAction()` now trusts the pre-redacted `entry.toolInput` and only runs `redactSensitiveFields` on `toolOutput` (which is added raw in `executeAndLog()`).

## Changes Applied (2026-07-01) — Code Review Round 4

### 🟢 Cleanup: `health.service.spec.ts` — Removed Unused `appClient` Mock

**Problem:** `createMockPrisma()` created a mock for `appClient` but `getHealth()` only uses `this.prisma.admin`. The `appClient` mock was dead code.

**Fix:** Removed the unused `appClient` from the mock factory.

### 🟢 Cleanup: `main.ts` — Explicit Import of `tenant-context.ts` for Module Augmentation

**Problem:** `req.requestId` relied on the Express module augmentation (`declare module "express" { interface Request { requestId?: string } }`) being transitively imported via `AppModule → PartyModule → PartyController → tenant-context.ts`. If this import chain changed, `req.requestId` would silently cause a TypeScript error.

**Fix:** Added an explicit `import "./common/tenant-context.js"` in `main.ts` to make the dependency direct and stable.

## Changes Applied (2026-07-01) — Code Review Round 3

### 🟢 Cleanup: `validatePersonData` / `validateOrganizationData` — Eliminated Redundant `.trim()` Calls

**Problem:** `firstName`, `lastName`, and `legalName` were trimmed twice — once in the emptiness check and again in the `requireMaxLength` call.

**Fix:**
- Captured trimmed value once and reused for both checks
- Same fix applied to all three fields

### 🟢 Cleanup: `validateContactMechanismSubtype` — Captured Trimmed Return Values

**Problem:** `requireStringField()` returns the trimmed value, but the return values for `addressLine1`, `city`, and `country` were discarded in the POSTAL_ADDRESS branch, forcing `sanitizePostalAddress` to re-trim redundantly.

**Fix:**
- Captured `trimmedCountry` return value and reused for the ISO 3166-1 min-length check
- Calls for `addressLine1`, `city`, `areaCode`, and `lineNumber` now follow the same capture-or-discard pattern with clear intent

### 🟢 Fix: `DomainExceptionFilter` — Include Error Code in Production Responses

**Problem:** The `error` code field (e.g., `"ENTITY_NOT_FOUND"`, `"DUPLICATE_ENTITY"`) was stripped from production HTTP responses. This forced API consumers to parse the `message` string to distinguish error types programmatically.

**Fix:**
- `error` code is now always included in the response body, regardless of environment
- `suggestedTools` and `context` fields remain development-only (they may leak implementation details)

## Previous Changes (2026-07-01) — Code Review Round 2

### 🟢 Defense-in-Depth: Non-String `partyType` Guard Added

**Problem:** `createParty()` assumed `partyType` was always a string. Direct/internal callers bypassing the DTO/Zod boundary could pass non-string values (e.g., `null`, `undefined`, numbers), causing a cryptic crash at `.trim()`.

**Fix:**
- Added `typeof partyType !== "string" || !partyType.trim()` guard before trimming
- Returns `InvalidTypeValueError` with clear message and context

### 🟢 Defense-in-Depth: Name Fully Consumed by HTML Sanitization Check

**Problem:** A name like `"<script>alert(1)</script>"` passes length validation but is entirely consumed by `stripHtmlTags`, resulting in an empty stored name. Boundary layers (REST DTO, MCP Zod) strip HTML before validation, but an internal caller bypassing them could store an empty name.

**Fix:**
- Added `if (!sanitizedName)` check after `sanitizeCreatePartyInput`
- Validates the name still has visible characters after HTML stripping

### 🟢 Fix: `gender` Whitespace-Only Input Normalized to `undefined`

**Problem:** `sanitizeCreatePartyInput` used `personData.gender ?` for the truthiness check, which passes for whitespace-only strings like `"   "`, resulting in an empty string being stored.

**Fix:**
- Changed to `personData.gender?.trim() ?` — consistent with the `middleName` pattern

### 🟢 Fix: Empty Description After HTML Stripping Normalized to `null`

**Problem:** A `description` like `"<script></script>"` validated as non-empty (length > 0 after trim), but `stripHtmlTags` consumed it entirely, storing an empty string.

**Fix:**
- `sanitizedDescription` now uses `stripHtmlTags(...) || null` to normalize empty results

## Previous Changes (2026-06-29) — Initial Review Recommendations

### 🟢 Test Coverage: `@besterp/shared/sanitize.ts` — 49 Unit Tests Added

**Problem:** `stripHtmlTags`, `sanitizeLogOutput`, `sanitizeForLog`, and `safeFromCodePoint` had zero unit test coverage despite handling security-critical input sanitization.

**Fix:**
- 18 tests for `stripHtmlTags`: empty string, plain text, HTML tag removal, script/style stripping, entity decoding (including double-encoded), HTML comments, null bytes, orphaned tags, deeply nested encoded strings, oversized input, mixed content, C0 controls, and edge cases.
- 10 tests for `sanitizeLogOutput`: redaction of PostgreSQL, Redis, MongoDB, MySQL, AMQP connection strings; generic `protocol://HOST/` patterns; file path scrubbing; multiple concurrent patterns; and safe message preservation.
- 8 tests for `sanitizeForLog`: newline, carriage return, tab, and ANSI escape removal; C0 control character replacement; and multi-injection input.
- 6 tests for `safeFromCodePoint`: valid code points, lone surrogates, negative values, out-of-range values, and NaN.

### 🟢 Cleanup: `EmailAddressDto.email` — Removed Redundant Double Transform

**Problem:** `email` field had both `@sanitizeTransform()` (`stripHtmlTags` + `trim`) and a separate `@Transform` (`trim` + `toLowerCase`), producing a wasteful double trim and a misleading separation of sanitization concerns.

**Fix:** Consolidated into a single `@Transform` that does `stripHtmlTags` + `trim` + `toLowerCase` in one pass. Also fixed the type annotation from `{ value }: { value: string }` to the correct `{ value }: TransformFnParams`.

### 🟢 Cleanup: `PostalAddressDto.country` — Fixed `@Transform` Type Annotation

**Problem:** The inline `@Transform` callback used `{ value }: { value: string }` instead of the proper `TransformFnParams` type that was already imported.

**Fix:** Changed to `{ value }: TransformFnParams` for type consistency with `sanitizeTransform()` and the rest of the codebase.

### 🟡 Significant: `requireStringField` Now Returns Trimmed Value

**Problem:** `PartyService.requireStringField()` returned `void`. Every call site had a two-line pattern:
`this.requireStringField(tenantId, ...); const trimmedTenantId = tenantId.trim();` — redundant
trimming that could drift out of sync.

**Fix:**
- `requireStringField()` now returns the trimmed value directly
- Simplified 6 call sites to a single line: `const trimmed = this.requireStringField(...)`
- Same pattern applied to `validateContactMechanismType`

### 🟡 Significant: `@prisma/client` Moved to Runtime Dependencies

**Problem:** `@prisma/client` was listed as a devDependency in `@besterp/shared/package.json`.
At runtime, `import { Prisma } from "@prisma/client"` in `errors.ts` would fail because
devDependencies are not installed in production.

**Fix:**
- Moved `@prisma/client` from devDependencies to dependencies in `@besterp/shared`

### 🟢 Cleanup: Void Floating Promises Explicitly

**Problem:** `health.controller.ts` `ready()` method had `healthPromise.catch(...)` without
`void`, triggering `@typescript-eslint/no-floating-promises` error.

**Fix:**
- Added `void` prefix to the fire-and-forget `.catch()` chain

### 🟢 Cleanup: Removed Dead `validation-utils.ts`

**Problem:** `packages/shared/src/validation-utils.ts` was a stale, 318-line file with
incompatible exports and dead code, removed in a prior commit but the file persisted.

**Fix:**
- Deleted `validation-utils.ts`
- All callers use the consolidated `validation.ts` module

### 🟢 Cleanup: `main.ts` Express Imports & Error Handler

- Changed `express` import from `import express from "express"` to static named import
  for tree-shaking consistency
- Added catch-all Express error handler middleware for safety net

### 🟢 Cleanup: PartyService — Trim `tenantId` Before Subtype Check

- Moved `tenantId.trim()` call before `partyType.trim()` in `createParty()` to match
  the validation order used by all other service methods
- `QueueModule` — trim `host` before connection validation

### 🔴 Critical: RLS Proxy `$transaction` Bug Fixed

**Problem:** `createTenantClient()` returned a Proxy that passed `$transaction` through
to the raw PrismaClient without intercepting it. When `PartyService` called
`db.$transaction(async (tx) => { tx.party.create(...) })`, the transaction
callback received the raw `tx` — `SET LOCAL` was never called, so RLS policies
were not active inside transactions.

**Fix:**
- The Proxy now intercepts `$transaction(fn)` and `$transaction(fn, options)` calls
- Before invoking the user's callback, it executes `SET LOCAL app.current_tenant`
- The transaction client (`tx`) inherits the tenant context for all its queries
- Batch `$transaction([...promises])` calls pass through (use interactive transactions for tenant-scoped ops)

### 🔴 Critical: Global Domain Exception Filter Added

**Problem:** Domain errors (EntityNotFoundError, InvalidTypeValueError, etc.) thrown
in services resulted in raw 500 Internal Server Errors. The `domainErrorToHttp()`
function existed but was never wired up.

**Fix:**
- New `DomainExceptionFilter` registered globally via `APP_FILTER` in AppModule
- Catches `DomainError` and maps to appropriate HTTP status codes:
  - `ENTITY_NOT_FOUND` → 404
  - `DUPLICATE_ENTITY`, `CONCURRENCY_CONFLICT` → 409
  - `MISSING_SUBTYPE_DATA`, `INVALID_TYPE_VALUE` → 422
- Returns structured JSON with `error`, `message`, `suggestedTools`, and `context`

### 🔴 Critical: Input Validation DTOs Added

**Problem:** The global `ValidationPipe` was configured but all controller methods used
plain TypeScript interfaces as body types. `class-validator` had no decorators to validate
against — all request bodies passed through unvalidated.

**Fix:**
- New `party.dto.ts` with class-validator DTOs for all party endpoints
- `CreatePartyDto`, `SearchPartiesDto`, `AddPartyRoleDto`, `AddContactMechanismDto`
- Subtype DTOs: `CreatePersonDto`, `CreateOrganizationDto`, `PostalAddressDto`, etc.
- `@ValidateNested()` + `@Type()` for nested object validation
- `SearchPartiesDto` replaces manual `parseInt` query parameter parsing with `@IsInt()` + `@Type()`
- Added `class-validator` and `class-transformer` as dependencies

### 🟡 Significant: TenantGuard Changed from Request-Scoped to Singleton

**Problem:** `TenantGuard` was annotated with `@Injectable({ scope: Scope.REQUEST })`,
which forces the entire injection chain to become request-scoped — a known NestJS
performance anti-pattern.

**Fix:**
- Removed `Scope.REQUEST` — guard is now singleton (default)
- Uses `context.switchToHttp().getRequest<Request>()` instead of `@Inject(REQUEST)`
- Accesses `req.user` via the ExecutionContext, which is always request-specific

### 🟡 Significant: `toPartyResult` Typed Properly

**Problem:** `toPartyResult(party: any)` used `any`, losing type safety at the
mapping boundary. Renaming a Prisma field would not cause a compile error.

**Fix:**
- Extracted `PartyWithIncludes` type alias using `Prisma.PartyGetPayload<{include: ...}>`
- `toPartyResult(party: PartyWithIncludes)` is now fully typed
- Removed all `any` casts in `searchParties` mapping

### 🟡 Significant: Missing Database Indexes Added

**Problem:** `party_role` had no index on `partyId` or `roleTypeId`. RLS policies
query `party_role` by `partyId IN (subquery)` — without an index, this becomes
a sequential scan as data grows.

**Fix:**
- Added `@@index([partyId])` and `@@index([roleTypeId])` on `PartyRole` model
- Added `@@index([contactMechanismId])` on `PartyContactMechanism` model
- Requires `npm run db:migrate` to apply

### 🟡 Significant: Idempotency Keys Now Required on All Write Tools

**Problem:** `add_party_role` and `add_contact_mechanism` MCP tools had
`idempotencyKey` as optional, inconsistent with ADR-004 which states "every
write tool must accept an idempotency key."

**Fix:**
- `idempotencyKey` is now required on `add_party_role` and `add_contact_mechanism`
- Updated descriptions with format guidance

### 🟡 Significant: Environment Variable Validation at Startup

**Problem:** `DATABASE_URL` and other critical env vars were not validated at startup.
Missing values caused confusing runtime errors deep in Prisma connection logic.

**Fix:**
- Added startup validation in `main.ts` for `DATABASE_URL` and `JWT_SECRET`
- Missing vars log a warning in development, exit with error in production

### 🟢 Cleanup: Removed Unused `TENANT_PRISMA` Token

- `TENANT_PRISMA` injection token was declared in `PrismaService` but never used
- Removed the unused export and cleaned up imports (`REQUEST`, `Scope`, `Inject`, etc.)

### 🟢 Cleanup: Idempotency Cleanup Script

- New `packages/database/scripts/cleanup-expired-idempotency.ts`
- Deletes expired idempotency records to prevent unbounded table growth
- Added `npm run db:cleanup` root script
- Should be run as a scheduled job (cron) in production

### 🟢 Cleanup: Fixed Health Controller Test

- Simplified from NestJS Test module to direct construction
- Removed fragile guard override that wasn't working

## New Files

- `apps/api/src/common/domain-exception.filter.ts` — Global DomainError → HTTP filter
- `apps/api/src/modules/core/party/party.dto.ts` — class-validator DTOs for party endpoints
- `packages/database/scripts/cleanup-expired-idempotency.ts` — Expired record cleanup

## Modified Files

- `packages/database/src/rls-extension.ts` — Intercept `$transaction` to inject SET LOCAL
- `apps/api/src/app.module.ts` — Added APP_FILTER registration
- `apps/api/src/main.ts` — Added env var validation
- `apps/api/src/modules/core/party/party.controller.ts` — Uses DTOs instead of plain types
- `apps/api/src/modules/core/party/party.service.ts` — Typed `toPartyResult`, removed `any`
- `apps/api/src/auth/tenant.guard.ts` — Singleton scope, uses ExecutionContext
- `apps/api/src/prisma/prisma.service.ts` — Removed unused TENANT_PRISMA + imports
- `apps/api/src/common/errors.ts` — Fixed MISSING_SUBTYPE_DATA → 422, added docs
- `apps/api/src/mcp/tools/party-tools.ts` — Required idempotencyKey on write tools
- `packages/database/prisma/schema.prisma` — Added indexes on party_role, party_contact_mechanism
- `apps/api/src/health.controller.spec.ts` — Simplified test construction
- `package.json` — Added `db:cleanup` script

## New Dependencies

- `apps/api`: class-validator, class-transformer

---

### 🔒 Critical: RLS Wired Into the Application

**Problem:** `PartyService` used the admin PrismaClient directly, filtering by `tenantId`
in `WHERE` clauses (application-level filtering). The RLS policies existed in the database
but were never exercised by the running application.

**Fix:**
- `PrismaService` now manages TWO connections:
  - `admin` — the superuser client (for migrations, audit, idempotency records)
  - `appClient` — the non-superuser client (subject to RLS)
- New `tenantScoped(tenantId)` method returns an RLS-enforced PrismaClient via `createTenantClient()`
- `PartyService` now uses `this.prisma.tenantScoped(tenantId)` for all domain operations
- Application-level `where: { tenantId }` filters retained as defense-in-depth

### 🔒 Critical: JWT Authentication Added

**Problem:** REST endpoints accepted `x-tenant-id` as a plain header with zero auth.
Anyone could access any tenant's data.

**Fix:**
- New `AuthModule` with `@nestjs/jwt` + `@nestjs/passport` + `passport-jwt`
- `JwtStrategy` validates tokens, extracts `{ sub, tenantId, role, agentId }`
- `JwtAuthGuard` applied globally via `APP_GUARD` — all endpoints require JWT
- `@Public()` decorator for health endpoints
- `TenantGuard` extracts `TenantContext` from JWT claims → `req.tenantContext`
- `PartyController` reads tenant from authenticated user, no more `x-tenant-id` header
- JWT_SECRET env var required (fails in production if missing)

### 🔒 Critical: `.env` and `dist/` Removed from Git Tracking

- Verified `.gitignore` properly excludes `.env`, `.env.local`, and `dist/`
- No tracked sensitive files found (already properly gitignored)

### 🛡️ Significant: Custom Domain Error Classes

**Problem:** Services threw `new Error("CODE: message")` strings, parsed by
`errorHandlerMiddleware` via fragile `indexOf(": ")` pattern matching.

**Fix:**
- New error classes in `@besterp/shared`: `DomainError`, `MissingSubtypeDataError`,
  `InvalidTypeValueError`, `DuplicateEntityError`, `EntityNotFoundError`, `ConcurrencyError`
- Each carries `code`, `message`, `suggestedTools`, and `context`
- `errorHandlerMiddleware` checks `isDomainError()` before falling back to Prisma/legacy patterns
- `PartyService` uses typed error classes throughout

### 🛡️ Significant: Idempotency Race Condition Fixed

**Problem:** Check-then-insert pattern in `idempotencyMiddleware` had a race window
where two concurrent requests with the same key could both create pending records.

**Fix:**
- Uses `prisma.idempotencyRecord.upsert()` for atomic check-or-create
- Only one concurrent request wins the create; others see the existing record

### 🛡️ Significant: `hashInput()` Determinism Fixed

**Problem:** `JSON.stringify(input)` doesn't guarantee key ordering.
`{ a: 1, b: 2 }` vs `{ b: 2, a: 1 }` produced different hashes.

**Fix:**
- New `sortKeysDeep()` helper recursively sorts object keys
- `hashInput()` now produces deterministic hashes regardless of key insertion order
- Added 2 new unit tests confirming key-order independence

### 🧹 Cleanup: Dead Code Removed

**Problem:** `tenantScopeExtension` in `@besterp/database` used `Prisma.defineExtension()`
with a `tenantScoped()` method that always threw an error at runtime.

**Fix:**
- Removed the misleading extension; `createTenantClient()` (Proxy-based) is the only API
- Simplified `@besterp/database` public API to just `createTenantClient`
- Added `"main"` and `"types"` fields to `packages/database/package.json`

### 🧹 Cleanup: Audit Middleware Uses Admin Client Explicitly

- `McpModule` now passes `this.prisma.admin` to audit/idempotency middleware
- Makes it explicit that these operations bypass RLS (intentional for cross-tenant audit)

---

## New Files

- `apps/api/src/auth/auth.module.ts` — JWT auth module
- `apps/api/src/auth/jwt.strategy.ts` — Passport JWT strategy
- `apps/api/src/auth/jwt-auth.guard.ts` — Global JWT guard with @Public() support
- `apps/api/src/auth/public.decorator.ts` — @Public() decorator
- `apps/api/src/auth/tenant.guard.ts` — Extracts tenant context from JWT
- `apps/api/src/common/tenant-context.ts` — TenantContext interface
- `apps/api/src/common/errors.ts` — HTTP error mapping utilities

## Modified Files

- `apps/api/src/app.module.ts` — Added AuthModule, global guards
- `apps/api/src/main.ts` — Added ValidationPipe, JWT_SECRET check
- `apps/api/src/health.controller.ts` — Added @Public() decorator
- `apps/api/src/prisma/prisma.service.ts` — Dual-client (admin + app/RLS), tenantScoped()
- `apps/api/src/modules/core/party/party.service.ts` — RLS client + typed errors
- `apps/api/src/modules/core/party/party.controller.ts` — JWT auth, no x-tenant-id
- `apps/api/src/mcp/mcp.module.ts` — Explicit admin client for middleware
- `packages/shared/src/errors.ts` — Added DomainError hierarchy + kept richError
- `packages/shared/src/crypto.ts` — Deterministic key sorting
- `packages/shared/src/index.ts` — Updated exports
- `packages/database/src/rls-extension.ts` — Removed dead extension, kept createTenantClient
- `packages/database/src/index.ts` — Simplified exports
- `packages/mcp-tools/src/middleware/idempotency.ts` — Atomic upsert
- `packages/mcp-tools/src/middleware/error-handler.ts` — DomainError support
- `.env.example` — Added JWT_SECRET
- `.env` — Added JWT_SECRET (dev only)

## New Dependencies

- `apps/api`: @nestjs/jwt, @nestjs/passport, passport, passport-jwt, joi, @types/passport-jwt
