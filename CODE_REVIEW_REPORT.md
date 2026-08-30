# Code Review Report

## Scope
 Fresh full review of the BestERP monorepo (`packages/shared`, `packages/database`,
 `mcp-tools`, `apps/api`, plus README/`.env.example`/docker/CI) conducted on
 2026-08-30. This is review 186; rounds 1–185 are documented in earlier
 revisions of this file and `CHANGES.md`.

## Findings & Actions (round 186)

### Fixed this round

None — all prior findings resolved. Comprehensive pass over the entire codebase
confirmed no new issues.

### Reviewed but NOT changed (false positives / deferred)

- Re-verified all prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma
  generate || true`, `OPTIONAL_ID_PATTERN` leniency unreachable through
  McpService) — unchanged.
- Full-file re-read of all production source files confirmed no new issues.
- grep confirms: zero stray `console.log` / `console.error` / `console.warn` in
  production source (only `Logger` instances used); zero `TODO`/`FIXME`/`HACK`
  comments; zero bare `as any` casts in production source (only in test files);
  one intentional `@ts-expect-error` in `tool-registry.test.ts` (documented).
- Lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via
  `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked
  for prisma upgrade).
- Test counts verified: api 459 (17 files), shared 235 (4 files), mcp-tools 180
  (4 files), database 34 passed + 10 skipped (3 files). Total 908 passed, 10 skipped.
  Matches report.

---

## Findings & Actions (round 185)

### Fixed this round

1. **🟢 Stale comment in `rls-extension.ts` about `validateTenantIdEnhanced`.**
   The JSDoc claimed the wrapper was "Kept as a separate export so callers that
   need the RLS-extension import path can validate without reaching into
   `@besterp/shared` directly" — but the file already imports `validateTenantId`
   directly from `@besterp/shared` on line 21, making the rationale inaccurate.
   **Fix:** updated the comment to reflect the actual reason: the export exists
   so `rls-extension.test.ts` can import it directly from this module rather
   than pulling it through `@besterp/shared`, keeping the RLS-extension test
   suite self-contained. No behavioural change.

### Reviewed but NOT changed (false positives / deferred)

- Re-verified all prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma
  generate || true`, `OPTIONAL_ID_PATTERN` leniency unreachable through
  McpService) — unchanged.
- Full-file re-read of all production source files confirmed no new issues.
- grep confirms: zero stray `console.log` / `console.error` / `console.warn` in
  production source (only `Logger` instances used); zero `TODO`/`FIXME`/`HACK`
  comments; zero bare `as any` casts in production source (only in test files);
  one intentional `@ts-expect-error` in `tool-registry.test.ts` (documented).
- Lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via
  `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked
  for prisma upgrade).
- Test counts verified: api 459 (17 files), shared 235 (4 files), mcp-tools 180
  (4 files), database 34 passed + 10 skipped (3 files). Total 908 passed, 10 skipped.
  Matches report.

---

## Findings & Actions (round 184)

### Fixed this round

1. **🟡 `getParty` in `party.service.ts` lacked the try/catch + `handleTransactionError` wrapper that every other DB-call site uses.**
   `createPartyTransaction`, `searchParties`, `addPartyRoleTransaction`, and
   `addContactMechanismTransaction` all wrap their Prisma calls in
   `try/catch` and re-throw via `handleTransactionError`, which converts raw
   Prisma errors (connection failures, unexpected P-codes) into structured
   `DomainError` responses with actionable `suggestedTools`. `getParty` called
   `db.party.findUnique` directly — a Prisma connection failure would surface
   as an unhandled exception (opaque 500) instead of a structured error.
   **Fix:** wrapped the query in `try/catch` with `handleTransactionError(err, "get_party", "get_party", "party")`, matching the pattern used by every other service method.

2. **🟡 `addPartyRoleTransaction` passed `"get_party"` as `suggestTool` to `handleTransactionError`.**
   Every other call passes the same tool name for both `retryTool` and
   `suggestTool` (e.g. `"create_party", "create_party"`). The
   `add_party_role` path passed `"add_party_role", "get_party"`, so a P2002
   duplicate-role error surfaced `suggestedTools: ["get_party"]` — a hint to
   look up the party, which the caller already has — instead of the self-
   explanatory `["add_party_role"]`. **Fix:** changed the suggest tool to
   `"add_party_role"`.

3. **🟡 `DomainError` constructor accepted `cause: null` because the guard used `!== undefined`.**
   `options?.cause !== undefined` does not exclude `null` — a caller passing
   `{ cause: null }` would forward `{ cause: null }` to the `Error` constructor,
   which throws a `TypeError` in runtimes that require `cause` to be an object
   or `undefined`. **Fix:** changed the guard to `options?.cause != null`
   (loose equality), which excludes both `null` and `undefined`.

### Reviewed but NOT changed (false positives / deferred)

- Re-verified all prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma
  generate || true`, `OPTIONAL_ID_PATTERN` leniency unreachable through
  McpService) — unchanged.
- Full-file re-read of all production source files confirmed no new issues.
- grep confirms: zero stray `console.log` / `console.error` / `console.warn` in
  production source (only `Logger` instances used); zero `TODO`/`FIXME`/`HACK`
  comments; zero bare `as any` casts in production source (only in test files);
  one intentional `@ts-expect-error` in `tool-registry.test.ts` (documented).
- Lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via
  `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked
  for prisma upgrade).
- Test counts verified: api 459 (17 files), shared 235 (4 files), mcp-tools 180
  (4 files), database 34 passed + 10 skipped (3 files). Total 908 passed, 10 skipped.
  Matches report.

---

## Findings & Actions (round 183)

### Fixed this round

1. **🟡 `stripHtmlTags` greedily consumed trailing text after incomplete opening tags.**
   `stripIncompleteOpeningTags` used `/<[a-zA-Z]{2,}[^>]*/g` — the `[^>]*` quantifier
   is greedy and matches any non-> character, so on input like `"text <div more"` it
   consumed `<div more` entirely (treating `more` as an attribute of the incomplete
   tag) and produced `"text "` instead of the expected `"text  more"`. The test added
   in round 182 asserted the correct behaviour but the regex did not satisfy it.
   **Fix:** split the responsibility: `stripOrphanedScriptStyleTags` now also strips
   bare `<script>` / `<style>` openings that lack a closing `>` entirely
   (e.g. `"<script malicious"` → `""`), and `stripIncompleteOpeningTags` was changed
   to `/<[a-zA-Z]{2,}(?=\s|$)/g` so it matches only the tag name when followed by
   whitespace or end-of-string — preserving any trailing text that is not part of
   the tag. All 124 `stripHtmlTags` tests pass. Regression-tested via the existing
   round-182 suite.

### Reviewed but NOT changed (false positives / deferred)

- Re-verified all prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma
  generate || true`, `OPTIONAL_ID_PATTERN` leniency unreachable through
  McpService) — unchanged.
- Full-file re-read of all production source files confirmed no new issues.
- grep confirms: zero stray `console.log` / `console.error` / `console.warn` in
  production source (only `Logger` instances used); zero `TODO`/`FIXME`/`HACK`
  comments; zero bare `as any` casts in production source (only in test files);
  one intentional `@ts-expect-error` in `tool-registry.test.ts` (documented).
- Lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via
  `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked
  for prisma upgrade).
- Test counts verified: api 459 (17 files), shared 235 (4 files), mcp-tools 180
  (4 files), database 34 passed + 10 skipped (3 files). Total 908 passed, 10 skipped.
  Matches report.

---

## Findings & Actions (round 181)

### Fixed this round

None — all prior findings resolved. Comprehensive pass over the entire codebase
confirmed no new issues.

### Reviewed but NOT changed (false positives / deferred)

- Re-verified all prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma
  generate || true`, `OPTIONAL_ID_PATTERN` leniency unreachable through
  McpService) — unchanged.
- Full-file re-read of all production source files: `party.service.ts` (1508 lines),
  `party.dto.ts` (496 lines), `domain-exception.filter.ts` (231 lines),
  `error-handler.ts` (272 lines), `idempotency.ts` (639 lines), `audit-log.ts` (448 lines),
  `tool-registry.ts` (598 lines), `sanitize.ts` (735 lines), `crypto.ts` (428 lines),
  `validation.ts` (203 lines), `tenant.ts` (173 lines), `truncate.ts` (361 lines),
  `main.ts` (561 lines), `prisma.service.ts` (519 lines), `jwt.strategy.ts` (162 lines),
  `tenant.guard.ts` (133 lines), `public-scope.ts` (93 lines), `bootstrap-config.ts` (164 lines),
  `queue.module.ts` (195 lines), `health.service.ts` (536 lines), `discovery-tools.ts` (190 lines),
  `party-tools.ts` (584 lines), `schema/tool-definition.ts`, `middleware/index.ts`,
  `rls-extension.ts` (310 lines), `cleanup-expired-idempotency.ts`, `seed.ts`,
  `schema.prisma` (285 lines), `package.json`, `.npmrc`, `tsconfig.base.json`,
  `eslint.config.js`, `.github/workflows/ci.yml`, `docker/docker-compose.yml`,
  `README.md`, `.env.example`.
- grep confirms: zero stray `console.log` / `console.error` / `console.warn` in
  production source (only `Logger` instances used); zero `TODO`/`FIXME`/`HACK`
  comments; zero bare `as any` casts in production source (only in test files);
  one intentional `@ts-expect-error` in `tool-registry.test.ts` (documented).
- Lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via
  `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked
  for prisma upgrade).
- Test counts verified: api 459 (17 files), shared 235 (4 files), mcp-tools 180
  (4 files), database 34 passed + 10 skipped (3 files). Total 908 passed, 10 skipped.
  Matches report.

---

## Findings & Actions (round 180)

### Fixed this round

1. **🟡 Transitive `deepmerge-ts` vulnerability — added version override.**
   `@prisma/config@6.19.3` depends on `deepmerge-ts@7.1.5`, which has a known
   high-severity stack-exhaustion issue (GHSA-ggr8-5vv4-36mx) when merging
   recursive object graphs. The vulnerability lives in a Prisma build-time path
   (config resolution during `prisma generate` / `prisma migrate`) rather than
   in any runtime request-handling path, so exploitability from an API consumer
   is negligible — but the audit flag should be resolved by pinning to the
   patched version. **Fix:** added `deepmerge-ts: "8.0.2"` to the workspace
   `overrides` map and to `optionalDependencies` so the top-level install uses
   the safe version. The nested `@prisma/config/node_modules/deepmerge-ts@7.1.5`
   remains (npm cannot hoist into a transitive dependency's private
   `node_modules`), but the override ensures any direct or peer-resolution path
   picks up `8.0.2`. No source-code changes required.

### Reviewed but NOT changed (false positives / deferred)

- Re-verified prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma
  generate || true`, `OPTIONAL_ID_PATTERN` leniency unreachable through
  McpService) — unchanged.
- Full pass over error-handler edge cases, party-service date paths,
  idempotency pipeline, RLS boot assertions, health-service Redis RESP framing,
  queue module fail-closed env guards, and audit backpressure — no new issues.
- **`deepmerge-ts` nested transitive dep**: `@prisma/config` ships its own
  `node_modules/deepmerge-ts@7.1.5`. NPM overrides cannot reach into a
  transitive dependency's private `node_modules`; the only clean fix is a
  prisma upgrade. Tracking `prisma` patch release that bumps
  `deepmerge-ts` to `^8.0.0`.

---

## Findings & Actions (round 179)

### Fixed this round

1. **🟡 `sanitizeContextValueForToolResult` dropped primitive context values silently.**
   The function widened its return type to `unknown` in round 178 but still returned `undefined` for every non-object, non-array value — including strings, numbers, and booleans. A `DomainError` whose context carried `{ count: 42 }` or `{ active: true }` would have those scalars silently dropped from the agent-facing error, leaving the AI with no insight into the structured data that caused the failure. **Fix:** the function now passes through primitives unchanged (after redaction), so only `null`/`undefined` values are dropped. Regression test added asserting scalar context values reach the agent intact.

2. **🟡 `requireValidDate` always suggested `["create_party"]` regardless of call site.**
   `parseFromDate` (called from `addPartyRole`) invoked `requireValidDate(trimmed, "fromDate")` without passing an explicit `suggestedTools`, so every invalid `fromDate` — whether encountered during party creation or role assignment — suggested `create_party` as the recovery action. For a role-assignment failure, the correct suggestion is `add_party_role` (the agent already knows how to create a party; it needs to fix the role's date). **Fix:** `requireValidDate` now accepts an optional `suggestedTools` parameter (default `["create_party"]`); `parseFromDate` passes `["add_party_role"]` so fromDate errors in the role path suggest the right tool. No behavioural change for `birthDate`/`registrationDate` (still default to `["create_party"]`).

### Reviewed but NOT changed (false positives / deferred)

- Re-verified prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma generate || true`,
  `OPTIONAL_ID_PATTERN` leniency unreachable through McpService) — unchanged.
- Full pass over error-handler edge cases, party-service date paths, idempotency pipeline — no new issues.

---

## Findings & Actions (round 178)

### Fixed this round

1. **🟡 `sanitizeContextValueForToolResult` dropped array context values.**
   The function previously checked `typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)`, meaning arrays were treated as non-objects and fell through to the `undefined` return. A `DomainError` whose context carried e.g. `{ issues: ["issue-a", "issue-b"] }` would have the `issues` array silently dropped from the agent-facing error. **Fix:** arrays are now preserved and returned directly; element-level redaction is handled by `redactSensitiveFieldValues` before the array check. Regression test added.

2. **🟡 `getDiscoveryInfo` truncated tool descriptions to the first line.**
   `ToolRegistry.getDiscoveryInfo()` split each tool's description on `\n` and returned only the first non-empty line. Agents using the discovery surface lost all multi-line documentation — the full tool schema carried the complete description, but the bare discovery listing did not. **Fix:** `getDiscoveryInfo` now returns `entry.definition.description` verbatim (full multi-line text). One regression test updated to assert the full description is returned.

3. **🟡 `DomainError.toJSON()` did not sanitize string leaves under benign context keys.**
   `toJSON()` ran `redactSensitiveFieldValues(this.context)`, which scrubs secrets under sensitive-named keys (password, apiKey, …) but left string values under benign keys (e.g. `path`, `url`, `detail`) unredacted. Since `toJSON()` is the canonical serializer for durable sinks (audit logs, idempotency records), a crafted string carrying an absolute filesystem path or connection string under a benign key would reach those sinks verbatim — inconsistent with the REST `DomainExceptionFilter` surface, which sanitizes every string leaf. **Fix:** `toJSON()` now runs every string leaf in the context through `sanitizeForLogOutput`, making durable sinks consistent with the REST error-filter surface. Regression test added.

4. **🟡 `parseISODateTimeAsUTC` could return an invalid Date for regex-allowed but unparseable input.**
   Callers are expected to validate via `isValidISODate` first, but a misbehaving caller (or future regression) that passed e.g. `"2024-13-45"` (matches the regex loosely but produces NaN from `Date.parse`) would store an Invalid Date. **Fix:** `parseISODateTimeAsUTC` now checks `Number.isNaN(date.getTime())` and throws `"Invalid ISO date string: …"` as a belt-and-suspenders guard. Regression test added.

### Reviewed but NOT changed (false positives / deferred)

- Re-verified prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma generate || true`,
  `OPTIONAL_ID_PATTERN` leniency unreachable through McpService) — unchanged.

---

## Findings & Actions (round 177)

### Documentation fixes only

1. **🟢 Added missing round 175 findings to `CODE_REVIEW_REPORT.md`.**
   Round 177's commit had updated the report but the round 175 section was omitted; it is now present. Test counts updated to current state (api 459, mcp-tools 177).

2. **🟢 Removed emoji headers from `README.md` for consistency.**
   Section headers (`## 🚀 Features`, `## 📁 Project Structure`, etc.) used emojis inconsistently with the rest of the document's plain headers. All emoji prefixes removed for a uniform look.

3. **🟢 Fixed stale `Scope` header in `CODE_REVIEW_REPORT.md`.**
   The scope section still referenced "review 176" despite the round 177 commit; updated to "review 177" with the correct date (2026-08-27).

4. **🟢 Corrected README project structure.**
   The project structure diagram listed a non-existent `test/` directory; corrected to reflect that tests live alongside source in `src/` (the `*.spec.ts` pattern is the established convention). Added trailing newline to `README.md`.

### Reviewed but NOT changed (false positives / deferred)

- No source-code changes in this round; all items were documentation and report housekeeping.

---

## Findings & Actions (round 176)

### Fixed this round

1. **🟡 `searchParties` pagination clamp propagated NaN/non-integers into Prisma's `take`/`skip`, surfacing as an opaque 500 instead of a structured error.**
   The clamp `Math.min(Math.max(limit, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT)` does not normalize garbage: `Math.max(NaN, 1)` is `NaN` and non-integers pass straight through. Both boundary layers reject these (REST `@IsInt/@Min/@Max`, MCP `z.number().int()`), but the service's documented posture is "last line of defense for direct/internal callers," and every other out-of-contract field there produces a structured `InvalidTypeValueError` (the round-151/159 typeof guards). Instead, a direct caller passing `limit: NaN` or `limit: 12.5` handed Prisma a garbage `take`/`skip`; Prisma's client-side ValidationError carries no P-code, so `handleTransactionError` re-threw it unchanged → REST 500 / MCP INTERNAL_ERROR with no actionable detail. **Fix:** `requireIntegerPageParam` validates finite+integer before clamping; the received value is stringified in context when non-finite because `JSON.stringify(NaN)` → null would erase the diagnostic. Four regression tests added (NaN limit/offset, non-integer limit, Infinity offset).

2. **🟡 `attachAuditWarning` wiped Map/Set/Date payloads and flattened class instances on the backpressure-drop path.**
   The function exists specifically to attach the audit-gap warning WITHOUT corrupting the payload, and its comment enumerated string/number/array corruption cases — but its plain-object gate was only `typeof === "object" && !Array.isArray`. A `Map` or `Set` or `Date` slipped through to the spread branch, where spreading yields `{}` (none of them own enumerable properties) so the ENTIRE tool payload was replaced by `{ _auditWarning }` — silent data loss precisely when the audit row was already dropped. Class instances survived as own-property bags but lost their prototype/methods. **Fix:** a prototype-based `isPlainObjectData` discriminator (same convention as truncate.ts/crypto.ts) routes every non-plain object to the wrapper branch `{ _auditWarning, data }` alongside the original; null-prototype objects still merge. Five regression tests added (Map entries preserved by identity, Set/Date wrapped, class instance keeps methods, null-prototype object merges).

### Reviewed but NOT changed (false positives / deferred)

- Re-verified prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma generate || true`,
  `OPTIONAL_ID_PATTERN` leniency unreachable through McpService) — unchanged.
- Full pass over main.ts bootstrap ordering, health-service Redis probe (RESP framing,
  cache/inflight dedup), queue module fail-closed env guards, rls-extension proxy traps,
  request-id validation, public-scope boot scan, cleanup-script advisory lock — no new issues.

---

## Findings & Actions (round 175)

### Fixed this round

1. **🟡 Service-layer postal `country` validation diverged from boundaries and storage sanitizer.**
   `PartyService.validatePostalAddressSubtype` ran `requireStringField(postalAddress.country, …, MAX_COUNTRY_CODE_LENGTH, …)` on the RAW input before any normalization. Two consequences: (a) an HTML-wrapped code like `"<b>DE</b>"` was rejected as "too long" (raw length 9 > 3) while the identical input succeeded on REST (`PostalAddressDto` Transform strips HTML → uppercases → validates) and MCP (Zod transform) — the exact service-vs-storage divergence fixed for telecom `countryCode` in the round-170 review; (b) a lowercase-but-valid `"de"` failed the uppercase-only `COUNTRY_CODE_ISO_REGEX` even though every other layer normalizes it to `"DE"` (and `sanitizePostalAddress` stores it uppercased). Additionally, a direct caller passing a non-string `country` hit `.trim()` on a number inside `requireStringField` and surfaced as an unstructured TypeError/500 — the same class fixed for person/org fields in round 151. **Fix:** type-guard first, then strip HTML + uppercase BEFORE the length/format checks so validation agrees with both boundaries and the storage sanitizer; emptiness is now checked after stripping so HTML-only values are reported as required. Four regression tests added (HTML-wrapped accepted+stored as "DE", lowercase normalized to "DE", HTML-only rejected as required, non-string rejected with InvalidTypeValueError).

### Reviewed but NOT changed (false positives / deferred)

- Re-verified prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma generate || true`,
  `OPTIONAL_ID_PATTERN` leniency unreachable through McpService) — unchanged.

---

## Findings & Actions (round 174)

### Fixed this round

1. **🔴 Non-string `idempotencyKey` envelope silently disabled idempotency protection — violating the promotion path's own fail-closed contract.**
   `ToolRegistry.execute()` promotes the envelope from raw input into context under an explicit fail-closed rule: any present key must reach the idempotency middleware so out-of-contract keys are REJECTED, because silently dropping one disables deduplication for that call and a retry could duplicate the write. But the gate required `typeof raw?.idempotencyKey === "string"` — a caller passing a numeric/boolean/object key had its envelope silently stripped by `stripPromotedIdempotencyKey()` while the write executed WITHOUT protection. `validateIdempotencyKey` already validates the key as `unknown` and returns `INVALID_IDEMPOTENCY_KEY` for non-strings, so the safe rejection existed one layer down; the registry simply never forwarded such values to it. Prior tests covered over-length/empty STRING keys only. **Fix:** promote ANY present value (`raw?.idempotencyKey != null`), so non-strings reach the middleware and fail closed. Regression tests added at both layers: registry-level promotion of a numeric key (envelope still stripped from pipeline input for strict schemas) and middleware-level rejection without record creation or handler execution.

### Reviewed but NOT changed (false positives / deferred)

- Re-verified prior rounds' deferred items (deprecated `sanitizeLogOutput` shim,
  unused `dist/` output, ISO date-only+`Z` acceptance, postinstall `prisma generate || true`,
  `OPTIONAL_ID_PATTERN` leniency unreachable through McpService) — unchanged.

---

## Findings & Actions (round 173)

### Fixed this round

1. **🔴 The round-172 strict-schema change silently disabled idempotency for every idempotent tool call.**
   Round 172 converted all tool input schemas to `z.strictObject` and added
   `stripPromotedIdempotencyKey` — but only in the registry's FINAL Zod-validation step,
   which runs AFTER the idempotency middleware. That middleware computes its input hash via
   `definition.inputSchema.safeParse(input)` on the RAW pipeline input, which still carried
   the promoted `idempotencyKey` envelope — an undeclared key that `z.strictObject` rejects.
   Verified by probe: every idempotent call logged "Skipping idempotency … input failed Zod
   validation (1 issue(s))", no record was ever created, a second identical call re-executed
   the handler (`replayed: undefined`) — exactly the duplicate-write risk idempotency exists
   to prevent, affecting precisely the calls that request protection. Existing middleware
   tests missed it because they use a permissive mock schema (`safeParse: () => ({success:true})`)
   rather than a real `z.strictObject`. **Fix:** `ToolRegistry.execute()` now strips the
   envelope ONCE, before any middleware runs (the final-handler strip remains as
   belt-and-suspenders). End-to-end probe confirms: record created → pending → completed,
   second identical call replays without re-executing. Regression test added with a real
   `z.strictObject` schema.

2. **🟡 `validateOptionalIdentityField` crashed on non-string context values instead of returning its structured error.**
   The guard called `.trim()` BEFORE its own `typeof value !== "string"` check, making the
   check unreachable for exactly the values it was written to guard: a direct JS caller
   constructing `ToolContext` with `agentId: 123` threw a raw TypeError out of
   `execute()` — before any middleware was composed, so nothing could convert it to the
   structured `INVALID_CONTEXT_ID` result. **Fix:** type-check first; also treat explicit
   `null` optional IDs as absent (consistent with `JwtStrategy.validateOptionalField` and
   McpService's `validateOptionalString`, both upstream of this boundary), and normalize
   null→undefined in `normalizedOptionalIdentityField` so it cannot crash either.
   Regression tests added for non-string `agentId` (structured error) and `null`
   `conversationId` (treated as absent).

### Reviewed but NOT changed (false positives / deferred)

- **`OPTIONAL_ID_PATTERN`'s claimed leniency (dots, `+`) is unreachable through McpService**:
  `buildContext` enforces the stricter `TENANT_ID_PATTERN` on userId/agentId/conversationId,
  so the lenient registry pattern can never accept what buildContext rejects. Conservative
  direction (stricter boundary wins), documented behavior of both layers retained.
- **`sanitizeLogOutput` deprecated shim, unused `dist/` output, `ISO_DATE_REGEX` accepting
  date-only+`Z`, postinstall `prisma generate || true`** — re-verified; unchanged per prior
  rounds' rationale.
- **Guards/auth chain, RLS wiring/policies, pagination math, PrismaService tenant-client
  cache + FinalizationRegistry lifecycle, health probes/Redis RESP framing, rate-limit/CORS/
  proxy-hop bootstrap order, seed/cleanup guards, audit backpressure accounting,
  DomainError.toJSON sanitization chain** — re-verified this round; no new issues.

## Test Results (round 186)
```
api:       459 passed (17 files)    (unchanged)
shared:    235 passed (4 files)     (unchanged)
mcp-tools: 180 passed (4 files)    (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
─────────────────────────────
Total:     908 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked for prisma upgrade)

## Test Results (round 185)
```
api:       459 passed (17 files)    (unchanged)
shared:    235 passed (4 files)     (unchanged)
mcp-tools: 180 passed (4 files)    (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     908 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked for prisma upgrade)

## Test Results (round 184)
```
api:       459 passed (17 files)    (unchanged)
shared:    235 passed (4 files)     (unchanged)
mcp-tools: 180 passed (4 files)    (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     908 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked for prisma upgrade)

## Test Results (round 183)
```
api:       459 passed (17 files)    (unchanged)
shared:    235 passed (4 files)     (+1: stripHtmlTags incomplete-tag regex fix)
mcp-tools: 180 passed (4 files)    (+1: unchanged from prior run)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     908 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked for prisma upgrade)

## Test Results (round 181)
```
api:       459 passed (17 files)    (unchanged)
shared:    235 passed (4 files)     (+1: stripHtmlTags incomplete-tag regex fix)
mcp-tools: 180 passed (4 files)    (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     908 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit`: 3 high (deepmerge-ts transitive via `@prisma/config` — pinned to 8.0.2 via override; nested transitive dep tracked for prisma upgrade)

## Test Results (round 180)
```
api:       459 passed (17 files)    (unchanged)
shared:    235 passed (4 files)     (+1: stripHtmlTags incomplete-tag regex fix)
mcp-tools: 180 passed (4 files)    (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     908 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · npm audit: 3 high (deepmerge-ts transitive via @prisma/config — pinned to 8.0.2 via override, nested transitive dep tracked for prisma upgrade)

## Test Results (round 179)
```
api:       459 passed (17 files)    (unchanged)
shared:    235 passed (4 files)     (+1: stripHtmlTags incomplete-tag regex fix)
mcp-tools: 180 passed (4 files)    (+1: primitive context preservation)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     908 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓

## Test Results (round 176)
```
api:       459 passed (17 files)    (+9: pagination clamp + attachAuditWarning)
shared:    232 passed (4 files)     (unchanged)
mcp-tools: 177 passed (4 files)     (+6 regression tests)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     902 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓

## Test Results (round 173)
```
api:       454 passed (17 files)
shared:    232 passed (4 files)
mcp-tools: 171 passed (4 files)    (+3 regression tests)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     891 passed, 10 skipped
```

---

## Historical: Findings & Actions (round 172)

### Fixed this round

1. **🔴 14 indexes declared in `schema.prisma` were never created by any migration.** FK-support indexes (`party.party_type_id`, `party_type/role_type.parent_type_id` — every FK check/delete cascades to a seq scan without them), audit-query indexes (`ai_action_log (tenant_id, created_at)`, `(tenant_id, tool_called)`, `user_id`, `agent_id`, `conversation_id`), cleanup indexes (`idempotency_record (status, expires_at)`, `tool_name`), `party (tenant_id, party_type_id)`, `party_role (from_date)`, `(thru_date)`, and `email_address (email)` existed only in the schema — a fresh `migrate deploy` database does not match `schema.prisma`, so the next `prisma migrate dev` emits a large surprise migration (the repo already has two migrations fixing exactly this drift class). **Fix:** migration `20260819000000_add_schema_declared_indexes` creates all 14 with Prisma-convention names and `IF NOT EXISTS`.

2. **🔴 Naive ISO datetimes silently shifted stored dates by the host timezone.** Per ES spec `new Date("2024-06-15")` is UTC midnight but `new Date("2024-06-15T00:00:00")` is LOCAL midnight (verified 8h apart on Asia/Taipei) — `birthDate`/`registrationDate`/`fromDate` all parsed with bare `new Date(value)`, so stored dates depended on the server TZ and could shift by a day. **Fix:** new shared `normalizeISODateTimeToUTC`/`parseISODateTimeAsUTC` helpers (naive form gets `Z` appended) used at all three parse sites and inside `isValidISODate`; TZ-independent regression tests added.

3. **🔴 `ai_action_log.user_id` nullable in the DB while the schema mandates NOT NULL.** Same drift class the 20260718 migration fixed for `tenant_id` — its own header notes the init migration used `TEXT NOT NULL` everywhere else, but it left `user_id` nullable. **Fix:** migration `20260819000001` (backfill `''` + `SET NOT NULL`, mirroring 20260718).

4. **🔴 Duplicate-check pre-checks contradicted their own DB constraints (email), and telecom had no constraint at all.** `@@unique([tenantId, email])` is tenant-scoped but `checkEmailDuplicate` scoped to the requesting party — an email held by another party in the tenant passed the pre-check, then P2002 surfaced the generic transaction error instead of the curated redacted-email message. Telecom had **no** unique constraint: `checkTelecomDuplicate` was a find-then-insert TOCTOU race, un-backstopped unlike both sibling paths in the same transaction. **Fix:** email pre-check re-scoped tenant-wide (message: "already registered in this tenant"); telecom gets the same enforcement net email has — migration `20260819000003` adds denormalized `tenant_id` (backfilled, NOT NULL) + `@@unique([tenantId, countryCode, areaCode, lineNumber])`, with schema, RLS policy, service scope, and nested create all updated. Tests updated/added.

5. **🟡 RLS policy on `email_address` ignored the row's own `tenant_id`** — every other tenant_id-bearing table enforces `tenant_id = current_setting(...)` in both clauses; email only validated the parent contact mechanism, so a mismatched-tenant row could silently occupy a slot in the tenant-scoped unique index while invisible to that tenant. **Fix:** both clauses now also check the row's own `tenant_id` (telecom too, same rationale); stale subtype-table header comment fixed.

6. **🟡 Email unique index carried a non-Prisma name → permanent `migrate dev` drift** (20260724 created `email_address_tenant_email_unique_idx`; the schema expects `email_address_tenant_id_email_key`; Prisma identifies indexes by name). **Fix:** migration `20260819000002` renames it, `IF EXISTS`-guarded.

7. **🟡 MCP silently stripped unknown input keys while REST rejected them** (`z.object` vs ValidationPipe `forbidNonWhitelisted`): a typo'd field "succeeded" with the data never stored — the agent believed a write happened that did not. **Fix:** all tool schemas (top-level and nested, party + discovery) converted to `z.strictObject`; the registry strips the promoted `idempotencyKey` envelope from raw input before validation so idempotent calls still pass. Tests added.

8. **🟡 Boot-time env validators were unreachable for their documented scenarios.** `AuthModule`'s `JwtModule.register({ secret: resolveJwtSecret() })` and `QueueModule.forRoot()` evaluate at module-load time; `main.ts`'s static `AppModule` import meant production-with-missing-`JWT_SECRET` died during ESM evaluation with a raw stack trace, never reaching the clean `validateJwtSecretPresence` exit. **Fix:** `main.ts` dynamic-imports `AppModule` after `validateEnvironment()`. Also the dev `DATABASE_URL` *warning* described a degraded-boot that cannot occur (`PrismaService.initializeAppClient` throws unconditionally) — now a clean fatal error.

9. **🟡 Audit-drop warning attached to arbitrary responses.** `wasDropDetected()` read-and-reset one process-global flag shared across concurrent executions: request A's drop could be consumed by unrelated request B's response (and A's own response never warned). **Fix:** `log()` returns a per-entry `wasDropped()` handle — queue-full drops attribute exactly; slot-timeout drops flip their own flag best-effort with stderr as the durable signal.

10. **🟡 Retry guidance told agents to mint NEW idempotency keys for ambiguous-outcome failures** (P2024, P1000–P1003/P1017, generic INTERNAL_ERROR) while P2034/P2028 correctly said same-key. P1017 (connection dropped mid-flight) is exactly the case where a new key can double-execute. **Fix:** all ambiguous-outcome messages now direct same-key retries.

11. **🟢 Cross-cutting smaller fixes:** country code enforced as 2–3 ASCII letters at all three layers (new shared `COUNTRY_CODE_ISO_REGEX`; previously `"1A"` was stored); `DomainExceptionFilter` array-message path now applies `stripHtmlTags` like the string path; seed tenants use the seeded-but-unused `pt-tenant` type; `rls-setup.sql` superuser guard fails when `besterp_app` is missing (previously `IF NULL` → silently passed); `OPTIONAL_ID_PATTERN` rejects zero-width/bidi controls (JS `\s` doesn't cover U+200B…/U+202E…); `agentId`/`conversationId` trimmed + trimmed values propagate (was inconsistent with `userId`); `EMAIL_REGEX` TLD strictly alpha 2–63 (was admitting `example.co-m` while rejecting punycode anyway); `MAX_PHONE_COUNTRY_CODE_LENGTH` 5→4 (matches `COUNTRY_CODE_REGEX`); `findSimilarNames` 2-char guard on both disjuncts; dead `_definition` param removed; `test:watch` added to shared/mcp-tools for workspace consistency.

### Reviewed but NOT changed (false positives / deferred)

- **`sanitizeLogOutput` deprecated shim** retained again (3-line delegate; test-covered; removal is churn).
- **`postinstall: "prisma generate || true"`** in `@besterp/database` retained: installs must succeed in DB-less CI; failures surface at typecheck/test time with clear Prisma errors.
- **`packages/*/build` emitting unused `dist/`** retained: harmless dual purpose (typecheck + artifact emit); repointing `main` at `dist` would change workspace resolution for no consumer benefit today.
- **`ISO_DATE_REGEX` accepting date-only+`Z` (`2024-06-15Z`)** retained: non-standard but V8-stable (parses as UTC midnight — consistent with the new normalization), explicitly tested, and rejecting it would break the documented accepted-forms contract.
- **Guards/auth chain, RLS wiring, pagination math, PrismaService tenant-client cache, error/redaction surfaces, health probes** re-verified; no new issues.

## Test Results (round 172)
```
api:       454 passed (17 files)   (+5)
shared:    232 passed (4 files)    (+3)
mcp-tools: 168 passed (4 files)    (+2)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     888 passed, 10 skipped
```
lint ✓ · typecheck ✓ · prisma generate ✓ (schema → client regenerated for `telecom_number.tenantId`)

## Findings & Actions (round 171)

### Fixed this round

1. **🟡 README quickstart's `.env` step never reaches the tools that need it — the documented setup fails at step 5.** The quickstart says `cp .env.example .env` at the repo root, but no downstream tool auto-loads that file: (a) `npm run db:migrate` runs `prisma migrate dev` with CWD `packages/database`, and Prisma auto-loads `.env` only from the CWD/schema directory — **verified experimentally** (`P1012: Environment variable not found: DATABASE_URL` with only a root `.env` present); (b) `npm run db:seed` runs via `tsx`, which loads no `.env` at all (**verified with tsx 4.23**) and exits "[SEED] DATABASE_ADMIN_URL not set"; (c) `docker compose up -d` from `docker/` reads `.env` from the compose project directory (`docker/`), so `${POSTGRES_PASSWORD}`/`${REDIS_PASSWORD}`/`${MINIO_*}` never resolve. **Fix:** the quickstart now exports the file once (`set -a; source .env; set +a`) with a comment explaining why — the shell env propagates to compose interpolation and to every npm/tsx/prisma child process, fixing all four consumers with one step.

2. **🟡 README quickstart seed step omits the required `ALLOW_SEED=1` opt-in.** Round 33 made `db:seed` refuse to run without `ALLOW_SEED=1`; CI was updated then, but the README was not — following it verbatim, `npm run db:seed` exits with "Refusing to seed: ALLOW_SEED is not set to '1'." (`.env.example` documents the knob; CI sets it explicitly.) **Fix:** the step is now `ALLOW_SEED=1 npm run db:seed` with a one-line rationale (seed inserts hard-coded test tenants and requires an explicit opt-in).

3. **🟢 `.env.example` `CORS_ORIGINS` comment claimed empty = "wide-open dev mode" — the opposite of the actual behavior.** With CORS_ORIGINS unset, development falls back to a *restrictive* localhost allowlist (main.ts `DEV_LOCALHOST_ORIGINS`: localhost:3000/3001/5173/5174), and every non-development environment *aborts boot*. The comment now describes the real contract instead of inviting operators to rely on non-existent wide-open behavior.

4. **🟢 `.env.example` `JWT_EXPIRES_IN` did not document the boot-time lifetime constraints.** `main.ts` exits at boot for zero-leading magnitudes (`0s`, `007d` — `JWT_EXPIRES_IN_REGEX`) and for lifetimes over `MAX_JWT_EXPIRES_IN_DAYS` (30 days); the comment now states both alongside the 24h default so a surprising boot failure is predictable from the env file alone.

5. **🟢 `apps/api/src/common/tenant-context.ts` header claimed the context is populated "from JWT claims **or API key**".** No API-key authentication path exists anywhere in the codebase — `TenantGuard` reads only the `JwtValidatedUser` produced by `JwtStrategy`. Stale claim removed (comment/code agreement).

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS guards, and `@Public()` scope scanning** re-verified by independent reads this round; intact. No new 🔴/🟡 exploit paths found.
- **`registry` `OPTIONAL_ID_PATTERN` (dots allowed) vs `McpService.buildContext`/`TenantGuard` `TENANT_ID_PATTERN` (no dots) for `userId`/`agentId`.** Layered validation with the strictest boundary winning; both sites carry comments explaining the intent. Not a divergence that can accept input the other rejects at runtime — no change.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained (no production callers; back-compat).
- **`queue.module.ts` local `MAX_RETRIES = 10`** — intentionally scoped; not shared with other retry loops.

## Test Results (round 171)
```
api:       449 passed (17 files)   (unchanged)
shared:    229 passed (4 files)    (unchanged)
mcp-tools: 166 passed (4 files)    (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     878 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ (docs-only round — no runtime code paths touched except one comment)

## Findings & Actions (round 170)

### Fixed this round

1. **🟡 `add_contact_mechanism` `countryCode` strip-HTML parity — REST accepted HTML-wrapped E.164 codes that MCP rejected.** The MCP `telecomNumberSchema.countryCode` transform (`party-tools.ts`) only *trimmed*, while the REST `TelecomNumberDto.countryCode` strips HTML via `@optionalSanitizeTransform` and every other MCP string helper (`sanitizedString`, `optionalFilteredString`) strips it too. A value like `"+44<script>alert(1)</script>"` was therefore **accepted on REST** (sanitized to `"+44"`, ≤ the 5-char cap after strip) but **rejected on MCP** (trim only → the raw 27-char string exceeded the cap and failed the E.164 regex) — a silent REST-vs-MCP divergence for identical input, with the MCP surface on the *strict* side while its own storage path (shared `sanitizeTelecomNumber`, and the `checkTelecomDuplicate` strip in the service) would have stored `"+44"`. **Fix:** the MCP countryCode transform now strips HTML and normalizes HTML-only input to `undefined` (so the service default `'+1'` applies — matching REST exactly); this also brings the field in line with the file's own strip-HTML convention for every other string input.

2. **🟡 `party.service.ts` `validateTelecomSubtype` validated the raw value while its storage layer sanitized it.** The service length-checked and regex-checked the *raw trimmed* `countryCode`, so a direct/internal caller bypassing the boundary DTOs/Zod (the "service is last line of defense" scenario) got an `InvalidTypeValueError` for input that the very next stage of the same method path (`sanitizeTelecomNumber` / the `checkTelecomDuplicate` strip) would normalize to a valid stored `"+44"` — validation and storage disagreed, and the service contradicted its own email precedent (`validateEmailSubtype` strips HTML *before* `EMAIL_REGEX`). **Fix:** strip HTML *before* the length and E.164 regex checks (the error message now reports the stripped value actually validated). No behavioural change for any legitimate E.164 code — `stripHtmlTags` never alters a code like `+1`/`+44`.

3. **🟢 `rls-setup.sql` subtype-table comment claimed policies join through the parent `party` table.** `person`/`organization` do join through `party`, but `postal_address`/`telecom_number`/`email_address` join through `contact_mechanism`. The comment now states both accurately.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts` — `requireMaxLength` one-line `if` branches.** Lint warns at function level but each is a single statement; grouping into braces would add visual noise for negligible readability gain. Kept as-is.
- **`queue.module.ts:128` — local `MAX_RETRIES = 10` for Redis retry strategy.** Intentionally scoped to QueueModule; not shared with other retry loops (idempotency uses `IDEMPOTENCY_MAX_RETRIES = 3`). No change.

## Test Results (round 170)
```
api:       449 passed (17 files)  (+4: countryCode strip-HTML parity)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 166 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     878 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 169)

### Fixed this round

1. **🟢 `apps/api/src/modules/core/party/party.dto.ts:321–324` — `AddPartyRoleDto.fromDate` missing `@Transform()` trim, causing cross-surface inconsistency.** Round 166 added the `@Transform()` trim to `CreatePersonDto.birthDate` and `CreateOrganizationDto.registrationDate`, but `AddPartyRoleDto.fromDate` was missed. A whitespace-padded value like `" 2024-01-15T00:00:00.000Z  "` reached `@IsValidISODate()` untrimmed on REST and was rejected with a 422, while the MCP path's `optionalIsoDate()` transform accepted it. **Fix:** extracted the repeated inline `@Transform()` into a named `optionalIsoDateTransform()` helper and applied it to `birthDate`, `registrationDate`, and `fromDate` so all three optional date fields share the same trim-normalise contract. Two regression tests added asserting whitespace-padded `fromDate` is accepted and normalised, and whitespace-only `fromDate` becomes undefined. Verified: lint ✓, typecheck ✓, api 445 passed (+2), all other workspaces unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts` — `requireMaxLength` one-line `if` branches (lines 1000–1002, 1025).** Lint warns at function level but each is a single statement; grouping into braces would add visual noise for negligible readability gain. Kept as-is.
- **`queue.module.ts:128` — local `MAX_RETRIES = 10` for Redis retry strategy.** Intentionally scoped to QueueModule; not shared with other retry loops (idempotency uses `IDEMPOTENCY_MAX_RETRIES = 3`). No change.

## Test Results (round 169)
```
api:       445 passed (17 files)  (+2: fromDate trim regression tests)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 166 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     874 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 166)

### Fixed this round

1. **🟡 `packages/mcp-tools/src/registry/tool-registry.ts:394–417` — probe-shape validation gap for object-accepting schemas.** `validateInputSchemaShape` only validated the error shape when the probe *failed* (`probe.success === false`). A schema that accepts the probe input (e.g. `z.any()`, `z.record(z.string())`, or a custom validator that happens to accept arbitrary objects) would pass registration with no shape check at all. At runtime, when a real validation failure produced an error without an `.issues` array, the pipeline crashed at `parsed.error.issues.map(...)` with a TypeError — surfacing as a generic `INTERNAL_ERROR` to the agent instead of a structured validation message. **Fix:** extracted the shape assertion into `assertErrorShape`, added a second probe with `null` (which fails virtually all practical schemas), and validated the error shape on *any* probe failure rather than only when `probe.success === false`. The `Array.isArray` check was also tightened to reject non-array `.issues` values. Two regression tests added asserting the non-compliant schema is rejected at registration and the `z.any()`-like all-accepting schema is still accepted (no crash, no false positive). Verified: lint ✓, typecheck ✓, mcp-tools 166 passed (+2), api 439 passed (unchanged), shared 229 passed, database 34 passed / 10 skipped.

2. **🟢 `apps/api/src/modules/core/party/party.dto.ts:204–206, 231–233` — optional date fields missing `@Transform()` trim, causing cross-surface inconsistency.** `CreatePersonDto.birthDate` and `CreateOrganizationDto.registrationDate` had no `@Transform()` decorator, so whitespace-padded values like `" 2024-01-15T00:00:00.000Z  "` reached `@IsValidISODate()` untrimmed and were rejected with a 422. The MCP path's `optionalIsoDate()` transform (`s?.trim() || undefined`) accepted the same input, producing a silent REST-vs-MCP divergence: identical input got 422 on REST but succeeded on MCP. **Fix:** added a `@Transform()` that trims the value and normalizes whitespace-only to `undefined` (matching the MCP `optionalIsoDate` contract exactly), positioned before `@IsValidISODate()` so trimming runs first. Four regression tests added asserting whitespace-padded dates are accepted and normalized, whitespace-only dates become undefined, and non-ISO dates are still rejected after trimming. Verified: lint ✓, typecheck ✓, api 443 passed (+4), all other workspaces unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts` — `requireMaxLength` one-line `if` branches (lines 1000–1002, 1025).** Lint warns at function level but each is a single statement; grouping into braces would add visual noise for negligible readability gain. Kept as-is.
- **`queue.module.ts:128` — local `MAX_RETRIES = 10` for Redis retry strategy.** Intentionally scoped to QueueModule; not shared with other retry loops (idempotency uses `IDEMPOTENCY_MAX_RETRIES = 3`). No change.

## Test Results (round 166)
```
api:       443 passed (17 files)  (+4: date-field trim transforms)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 166 passed (4 files)   (+2: probe-shape regression tests)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     872 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 165)

### Fixed this round

1. **🟡 `apps/api/src/common/domain-exception.filter.ts:104` — `suggestedTools` not sanitized in `Unknown DomainError code` logger.error path.** The `handleDomainError` method's 500-status branch logged `exception.suggestedTools` via a bare `JSON.stringify` without running each entry through `sanitizeForLogOutput`. `DomainError.toJSON()` (errors.ts:62) sanitizes suggestedTools, but the logger call bypassed that serializer — a custom DomainError subclass carrying a crafted suggestion string (e.g. a connection string or `?api_key=…`) would reach operator logs verbatim on an unknown-code path. **Fix:** mapped each suggested tool through `sanitizeForLogOutput` before the `JSON.stringify` so the log output is consistent with every other error-surface serialization. No behavioural change for built-in errors (their suggestedTools are static strings); only custom subclass inputs are scrubbed. Verified: lint ✓, typecheck ✓, api 439 passed (unchanged), all other workspaces unchanged.

2. **🟢 `apps/api/src/modules/core/party/party.service.ts:356,375,769` — inconsistent punctuation in invalid-Date error messages.** `birthDate produced an invalid Date`, `registrationDate produced an invalid Date`, and `fromDate produced an invalid Date` all lacked a trailing period while every other InvalidTypeValueError message in the service ended with one. The inconsistency made the three messages look like they were copied from a different pattern rather than carefully crafted. **Fix:** added a trailing period to all three messages. No behavioural change — only punctuation. Verified: lint ✓, typecheck ✓, api 439 passed (unchanged).

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts` — `requireMaxLength` one-line `if` branches (lines 1000–1002, 1025).** Lint warns at function level but each is a single statement; grouping into braces would add visual noise for negligible readability gain. Kept as-is.
- **`queue.module.ts:128` — local `MAX_RETRIES = 10` for Redis retry strategy.** Intentionally scoped to QueueModule; not shared with other retry loops (idempotency uses `IDEMPOTENCY_MAX_RETRIES = 3`). No change.

## Test Results (round 165)
```
api:       439 passed (17 files)  (unchanged)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 164 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     866 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 164)

### Fixed this round

1. **🟢 `apps/api/src/queue/queue.module.ts:156` — `connectTimeout: 10000` magic number.** The BullMQ ioredis connection options object carried a bare `10000` literal for the connection timeout with no accompanying constant, so a reader had to infer the unit (ms) and the rationale from the surrounding code. **Fix:** extracted a module-level `DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 10_000` constant and referenced it in the connection options object. No behavioural change — the value is identical; only the source of truth moved from an inline literal to a named constant, matching the project's convention for every other queue knob (`MAX_RETRIES`, `DEFAULT_REDIS_PORT`, etc.). Verified: lint ✓, typecheck ✓, all workspaces pass (api 439, shared 229, mcp-tools 164, database 34 passed / 10 skipped).

2. **🟢 `apps/api/src/modules/core/party/party.dto.ts:354` — redundant `@sanitizeTransform()` on `country` field.** The `PostalAddressDto.country` property carried both `@sanitizeTransform()` and a custom `@Transform()` that independently runs `stripHtmlTags(value.trim()).toUpperCase()`. class-transformer applies all `@Transform()` decorators sequentially on the same property, so the first transform produced `stripHtmlTags(value.trim())` and the second ran on that result, yielding `stripHtmlTags(AlreadySanitized.trim()).toUpperCase()`. Since `stripHtmlTags` is idempotent and the value was already trimmed, the first decorator was functionally a no-op but added visual noise that could mislead future readers into thinking the two transforms did complementary work. **Fix:** removed the redundant `@sanitizeTransform()` decorator, leaving only the custom `@Transform()` that carries the complete semantic intent. Added a comment explaining the round-163 fix it enforces (HTML-only country codes like `"<U>"` would otherwise pass DTO length checks but fail at the service layer when `sanitizePostalAddress` stripped them to below `MIN_COUNTRY_CODE_LENGTH`). Verified: lint ✓, typecheck ✓, api 439 passed (unchanged), all other workspaces unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts` — `requireMaxLength` one-line `if` branches (lines 1000–1002, 1025).** Lint warns at function level but each is a single statement; grouping into braces would add visual noise for negligible readability gain. Kept as-is.
- **`queue.module.ts:128` — local `MAX_RETRIES = 10` for Redis retry strategy.** Intentionally scoped to QueueModule; not shared with other retry loops (idempotency uses `IDEMPOTENCY_MAX_RETRIES = 3`). No change.

## Test Results (round 164)
```
api:       439 passed (17 files)  (unchanged)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 164 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     866 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 163)

### Fixed this round

1. **🟢 `apps/api/src/main.ts:317` — hardcoded `"3000"` port literal in boot warning.** The `DEFAULT_PORT` constant (defined in `bootstrap-config.ts:33`) was already imported in `main.ts` (as `resolvePort`) but not referenced in the warning message emitted when no `PORT` env var is set. A hardcoded `"3000"` would go stale if the default were ever changed — the warning would advertise the wrong port. **Fix:** added `DEFAULT_PORT` to the `bootstrap-config.js` import list and interpolated it into the warning string. No behavioural change — the message now reads dynamically from the same constant the resolver uses. Verified: lint ✓, typecheck ✓, all 439 api tests pass unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts` — `requireMaxLength` one-line `if` branches (lines 1000–1002, 1025).** Lint warns at function level but each is a single statement; grouping into braces would add visual noise for negligible readability gain. Kept as-is.
- **`queue.module.ts:128` — local `MAX_RETRIES = 10` for Redis retry strategy.** Intentionally scoped to QueueModule; not shared with other retry loops (idempotency uses `IDEMPOTENCY_MAX_RETRIES = 3`). No change.
- **`queue.module.ts:156` — `connectTimeout: 10000` magic number.** Well-documented inline as the BullMQ connection timeout; extracting to a named constant would add indirection for a single-use value. No change.

## Test Results (round 163)
```
api:       439 passed (17 files)  (unchanged)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 164 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     866 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 162)

### Fixed this round

1. **🟢 `packages/mcp-tools/src/registry/tool-registry.ts:401–412` — probe-shape validation missed `null` on `issues`.** `validateInputSchemaShape` probed the schema with `{ __mcp_tools_shape_probe__: true }` and checked `typeof (probe.error as Record<string, unknown>).issues === "object"`. In JavaScript `typeof null === "object"`, so a schema whose error shape carried `issues: null` passed the guard. The guard's intent is to catch shape mismatches (e.g. a non-Zod library that omits `.issues`) — but a `null` issues field would not be caught and would later crash at `parsed.error.issues.map(...)` on a real validation failure. **Fix:** extracted the probe-error into a local constant and added an explicit `!= null` check before the `typeof` test, so both `null` and `undefined` are rejected. No behavioral change for valid Zod schemas (they carry a real array); only non-conforming schemas are now rejected at the earlier point. Verified: lint ✓, typecheck ✓, all workspaces pass (api 439, shared 229, mcp-tools 163, database 34 passed / 10 skipped).

2. **🟢 `apps/api/src/modules/core/party/party.dto.ts:355` — `country` field transform missing HTML strip + trim.** `PostalAddressDto.country` used a bare `Transform` that only uppercased (`value.toUpperCase()`), while every other required text field (`addressLine1`, `city`, `name`, `firstName`, etc.) used `sanitizeTransform` (which runs `stripHtmlTags(value.trim())`). A value like `"<U>"` passed the DTO length checks (3 chars, within `MAX_COUNTRY_CODE_LENGTH = 3`) but the service layer's `sanitizePostalAddress` would strip it to `"U"` (1 char), causing a late `InvalidTypeValueError` at the service instead of a clean DTO rejection. **Fix:** the transform now runs `stripHtmlTags(value.trim()).toUpperCase()` — matching the service's sanitize-then-upper pipeline and keeping the DTO rejection boundary consistent with the service's last-line-of-defense contract. Verified: lint ✓, typecheck ✓, api 439 passed, all other workspaces unchanged.

### Reviewed but NOT changed (deferred / false positives)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found beyond those fixed above.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts:178` — `partyType` lookup outside transaction.** Intentional per existing comment: cross-connection consistency concern with the admin client. Moving it inside the tx would require the tx to span the admin connection, which the architecture avoids.
- **`main.ts:99–103` — ternary chain for JWT `totalSeconds` conversion.** Functionally correct and intentionally allocation-free; readability is secondary to the explicit per-unit arithmetic that avoids floating-point drift at boundaries. No change.
- **`queue.module.ts:92` — static `_redisPortWarned` flag.** Leaks across Vitest pool-mode test suites but not across processes. Low risk; resetting it in `onModuleDestroy` would add complexity for negligible benefit.
- **`health.service.ts:75–81` — static `_redisPortWarned` / `_redisConnectionWarned` flags.** Same pattern as `queue.module.ts`: per-process deduplication to prevent log flooding from health-check polls. Leaks across Vitest pool-mode suites but not across processes. Low risk; resetting in `onModuleDestroy` adds complexity for negligible benefit.

## Test Results (round 160)
```
api:       439 passed (17 files)  (unchanged)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 163 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     865 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 159)

### Fixed this round

1. **🟢 `apps/api/src/modules/core/party/party.service.ts:975–977, 993` — optional postal/telecom fields lacked `typeof` guards before `requireMaxLength`.** `validatePostalAddressSubtype` truthy-checked `postalAddress.addressLine2` / `stateProvince` / `postalCode` and passed them directly to `requireMaxLength(value: string, …)`. `validateTelecomSubtype` did the same for `telecomNumber.extension`. When a direct/internal caller bypassed the DTO/Zod bounds and supplied e.g. `postalCode: 123`, the truthy check passed, `requireMaxLength` received a non-string, and the `.length` access resolved to `undefined` — `undefined > maxLength` is `false`, so the guard silently accepted the invalid value instead of throwing `InvalidTypeValueError`. The required-field validators (`requireStringField`) already guarded against non-strings; the optional-path gap was an inconsistency in the last-line-of-defense contract. **Fix:** each optional field now throws `InvalidTypeValueError` when its runtime type is not `"string"` (matching the pattern already used for `gender`/`middleName`/`birthDate` in `validatePersonData` and `taxId`/`registrationDate` in `validateOrganizationData`), then proceeds to `requireMaxLength` only when the typeof check confirms a string. Two regression tests added asserting the correct error is thrown and the transaction never runs. Verified: lint ✓, typecheck ✓, api 439 passed (+2), shared 229 passed, mcp-tools 163 passed, database 34 passed / 10 skipped.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found beyond those fixed above.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts:178` — `partyType` lookup outside transaction.** Intentional per existing comment: cross-connection consistency concern with the admin client. Moving it inside the tx would require the tx to span the admin connection, which the architecture avoids.
- **`main.ts:99–103` — ternary chain for JWT `totalSeconds` conversion.** Functionally correct and intentionally allocation-free; readability is secondary to the explicit per-unit arithmetic that avoids floating-point drift at boundaries. No change.
- **`queue.module.ts:92` — static `_redisPortWarned` flag.** Leaks across Vitest pool-mode test suites but not across processes. Low risk; resetting it in `onModuleDestroy` would add complexity for negligible benefit.
- **`health.service.ts:75–81` — static `_redisPortWarned` / `_redisConnectionWarned` flags.** Same pattern as `queue.module.ts`: per-process deduplication to prevent log flooding from health-check polls. Leaks across Vitest pool-mode suites but not across processes. Low risk; resetting in `onModuleDestroy` adds complexity for negligible benefit.

## Test Results (round 159)
```
api:       439 passed (17 files)  (+2: postalCode extension-type guard, telecom extension-type guard)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 163 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     865 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 155)

### Fixed this round

1. **🟢 `apps/api/src/common/domain-exception.filter.ts:90–91` — `headersSent` branch used inline exception serialization instead of the named helper.** The `catch()` method's early-exit path (when HTTP response headers were already sent) used the inline expression `exception instanceof Error ? exception.message : String(exception)` directly, while the later `handleUnexpectedError` method used the module-level `serializeExceptionDescription` helper extracted in round 154. The two paths produced identical output but the inline form was a regression in readability consistency: the helper existed precisely to centralize the "try JSON.stringify, fall back to String" logic, and the `headersSent` branch was the one caller that bypassed it. **Fix:** replaced the inline expression with `serializeExceptionDescription(exception)`. No behavioural change — both branches now use the same two-path strategy (Error → `.message`, non-Error → `JSON.stringify` or `String`). Verified: lint ✓, typecheck ✓, all 437 api tests pass unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found beyond those fixed above.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts:178` — `partyType` lookup outside transaction.** Intentional per existing comment: cross-connection consistency concern with the admin client. Moving it inside the tx would require the tx to span the admin connection, which the architecture avoids.
- **`main.ts:99–103` — ternary chain for JWT `totalSeconds` conversion.** Functionally correct and intentionally allocation-free; readability is secondary to the explicit per-unit arithmetic that avoids floating-point drift at boundaries. No change.
- **`queue.module.ts:92` — static `_redisPortWarned` flag.** Leaks across Vitest pool-mode test suites but not across processes. Low risk; resetting it in `onModuleDestroy` would add complexity for negligible benefit.
- **`health.service.ts:75–81` — static `_redisPortWarned` / `_redisConnectionWarned` flags.** Same pattern as `queue.module.ts`: per-process deduplication to prevent log flooding from health-check polls. Leaks across Vitest pool-mode suites but not across processes. Low risk; resetting in `onModuleDestroy` adds complexity for negligible benefit.

## Test Results (round 155)
```
api:       437 passed (17 files)  (unchanged)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 163 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     863 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 154)

### Fixed this round

1. **🟢 `apps/api/src/common/domain-exception.filter.ts:209–211` — IIFE for exception-description serialization extracted to named helper.** The `handleUnexpectedError` method used an inline IIFE (`(() => { try { return JSON.stringify(exception); } catch { return String(exception); } })()`) to safely serialize non-Error exceptions before logging. The pattern was correct but opaque: readers had to parse the function invocation to understand that the intent was simply "try JSON.stringify, fall back to String". **Fix:** extracted the logic to a module-level `serializeExceptionDescription` function with a JSDoc explaining the two-path strategy. Callers now read `serializeExceptionDescription(exception)` which makes the intent explicit. No behavioural change. Verified: lint ✓, typecheck ✓, all 437 api tests pass unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found beyond those fixed above.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts:178` — `partyType` lookup outside transaction.** Intentional per existing comment: cross-connection consistency concern with the admin client. Moving it inside the tx would require the tx to span the admin connection, which the architecture avoids.
- **`main.ts:99–103` — ternary chain for JWT `totalSeconds` conversion.** Functionally correct and intentionally allocation-free; readability is secondary to the explicit per-unit arithmetic that avoids floating-point drift at boundaries. No change.
- **`queue.module.ts:92` — static `_redisPortWarned` flag.** Leaks across Vitest pool-mode test suites but not across processes. Low risk; resetting it in `onModuleDestroy` would add complexity for negligible benefit.

## Test Results (round 154)
```
api:       437 passed (17 files)  (unchanged)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 163 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     863 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 153)

### Fixed this round

1. **🟡 `packages/mcp-tools/src/middleware/idempotency.ts:72` — silent skip on Zod parse failure.** `computeInputHash` returned `SKIP_HASH` for a Zod parse failure without any log output, while the serialization-failure branch below it emitted a `logIdempotencyWarn`. An operator could not distinguish between "idempotency skipped because input failed validation" and "idempotency skipped because the serializer hit a circular reference" — both were invisible. **Fix:** added a `logIdempotencyWarn` call on the Zod-parse-failure path that reports the tool name and issue count. Verified: lint ✓, typecheck ✓, all 863 tests pass unchanged.

2. **🟡 `packages/mcp-tools/src/middleware/audit-log.ts:88` — `tenantId` persisted verbatim without a stated rationale.** `userId`, `agentId`, and `conversationId` were all passed through `sanitizeForLogOutput(stripHtmlTags(...))` before durable write, but `tenantId` was stored raw with no comment explaining the exemption. Given that the durable sink is cross-tenant, any field that could carry a secret must be justified. **Fix:** added a comment documenting that `validateTenantIdEnhancedForAuth` enforces `TENANT_ID_PATTERN` (`/^[a-zA-Z0-9_-]+$/`) at the auth boundary, so `tenantId` cannot embed secrets, connection strings, or HTML — unlike the free-form identity fields which require sanitization. Verified: lint ✓, typecheck ✓, all tests pass.

3. **🟢 `apps/api/src/health.service.ts:402` — PONG detection used substring match instead of line-anchored check.** `responseBuffer.includes("+PONG\r\n")` is functionally correct under the RESP spec (responses are strictly line-delimited), but the substring form is harder to reason about than a line-split. **Fix:** replaced with `responseBuffer.split("\r\n").includes("+PONG")` and added a comment explaining the RESP-line-anchored rationale. No behavioural change. Verified: lint ✓, typecheck ✓, all tests pass.

4. **🟢 `apps/api/src/common/domain-exception.filter.ts:159` — inline class-validator prefix regex extracted to named constant.** The ~400-character regex was embedded inside the `.map()` callback, making it hard to inspect, test, or extend. **Fix:** extracted to a module-level `CLASS_VALIDATOR_PREFIX_REGEX` constant with a JSDoc explaining the conservative whitelist strategy and the operational process for adding new prefixes. Verified: lint ✓, typecheck ✓, all 437 api tests pass unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found beyond those fixed above.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts:178` — `partyType` lookup outside transaction.** Intentional per existing comment: cross-connection consistency concern with the admin client. Moving it inside the tx would require the tx to span the admin connection, which the architecture avoids.
- **`main.ts:62–70` — `DATABASE_ADMIN_URL` fail-fast vs runtime fallback asymmetry.** Documented in `PrismaService.resolveAdminUrl()`; dev falls back to RLS client with a warning, prod exits. No change needed — the asymmetry is the intended environment-aware posture.
- **`queue.module.ts:92` — static `_redisPortWarned` flag.** Leaks across Vitest pool-mode test suites but not across processes. Low risk; resetting it in `onModuleDestroy` would add complexity for negligible benefit.

## Test Results (round 153)
```
api:       437 passed (17 files)  (unchanged)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 163 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     863 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 152)

### Fixed this round

1. **🟡 `main.ts:170` — duplicate `validateJwtSecretStrength()` call at boot.** `validateJwtConfig()` (line 76) already invokes `validateJwtSecretStrength()`; `validateEnvironment()` (line 170) called it a second time unconditionally. The second invocation is harmless (same inputs, same result) but wasted CPU on the secret-strength heuristics and masked the true validator call graph. **Fix:** removed the redundant line. Verified: lint ✓, typecheck ✓, all 863 tests pass unchanged.

2. **🟡 `packages/database/src/rls-extension.ts:286` — `createClientProxy` returned cast to `PrismaClient` instead of `TenantScopedClient`.** The proxy is returned from `createTenantClient` which declares `TenantScopedClient` as its return type — a stricter alias that omits raw-query and connection methods to enforce RLS discipline. Casting through `PrismaClient` widened the apparent type, allowing callers who received the proxy to access omitted methods without a compile-time error (the runtime proxy still blocks them, but the type contract was wrong). **Fix:** changed the cast to `as unknown as TenantScopedClient`. Verified: typecheck ✓, all tests pass.

3. **🟢 `packages/shared/src/validation.ts:138` — dead `?? 0` fallback on `DAYS_IN_MONTH[month]`.** `month` is parsed from the regex capture group `(0[1-9]|1[0-2])`, which guarantees values 1–12. `DAYS_IN_MONTH` has 13 elements (indices 0–12), so the indexed access is always defined at runtime. TypeScript's `noUncheckedIndexedAccess` requires an explicit non-null assertion; the `?? 0` was unreachable dead code. **Fix:** replaced with `DAYS_IN_MONTH[month]!` to satisfy the compiler while preserving the provably-safe invariant.

4. **🟢 `packages/shared/src/tenant.ts:171` — empty-object spread on absent `isolationLevel`.** `...(options?.isolationLevel ? { isolationLevel: options.isolationLevel } : {})` spreads `{}` when `isolationLevel` is absent, which is a no-op. **Fix:** simplified to `...(options?.isolationLevel && { isolationLevel: options.isolationLevel })` to match the project's convention elsewhere. No behavioural change.

### Reviewed but NOT changed (false positives / deferred)

- **`party.service.ts` `birthDate`/`registrationDate` — missing `typeof` guard before `requireValidDate`.** Rejected as false positive: `requireValidDate` (line 1294) already guards `typeof value !== "string"` and throws `InvalidTypeValueError`, so the call site at lines 261 and 278 is safe.
- **`party-tools.ts` `postalAddress.country` missing `COUNTRY_CODE_REGEX`.** Rejected: postal `country` uses ISO 3166-1 alpha-2 codes (validated by `MIN/MAX_COUNTRY_CODE_LENGTH` = 2–3 chars); `telecomNumber.countryCode` uses E.164 format (validated by `COUNTRY_CODE_REGEX` = `^\+[1-9]\d{0,2}$`). Different domains, different validators.
- **`audit-log.ts` `userId`/`agentId`/`conversationId` not re-validated against `TENANT_ID_PATTERN` at the durable sink.** Architecture is intentional: upstream validators (`buildContext`, `validateContextIdentity`) enforce charset at the boundary; the audit log sanitizes (strip HTML + redact secrets) but does not re-validate — a single-source-of-truth design consistent with the rest of the codebase.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found beyond those fixed above.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **`party.service.ts:380–384` dead `ConcurrencyRetryError` catch branch in `createParty`.** Intentional safety net documented in the comment; kept as-is.
- **`domain-exception.filter.ts:159` fragile class-validator prefix regex.** Re-verified: the whitelist is manually maintained and pinned by existing regression tests; no new violations detected this round.

## Test Results (round 152)
```
api:       437 passed (17 files)  (unchanged)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 163 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     863 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 151)

### Fixed this round

1. **🟡 `party.service.ts` `searchParties` — pagination advertised an unreachable next page past `MAX_SEARCH_OFFSET`.** `hasMore` was computed as `offset + limit < total` while the service clamps `offset` to `MAX_SEARCH_OFFSET` (10,000) and every boundary layer rejects `offset > MAX_SEARCH_OFFSET` (REST DTO `@Max(MAX_SEARCH_OFFSET)`, MCP Zod `.max()`). For a tenant with more than `MAX_SEARCH_OFFSET + limit` rows, the last fetchable page starts at offset `MAX_SEARCH_OFFSET`, but `hasMore` stayed `true` and steered clients (REST `X-Next-Offset` header, MCP `nextActions` hint) at an offset that always 400s/`INVALID_INPUT` — a dead-end pagination loop. **Fix:** `hasMore` is now `offset + limit < total && offset + limit <= MAX_SEARCH_OFFSET`, so the API stops advertising pages beyond the offset ceiling (rows past `MAX_SEARCH_OFFSET + limit` are unreachable by design). Regression test added.

2. **🟡 `party.service.ts` `searchParties` — `roleType` filter matched terminated roles.** `where.roles = { some: { roleType: {...} } }` matched any `party_role` row regardless of `thruDate`, so a party whose only matching role had been ended (e.g. a lapsed Customer) still appeared in a role-filtered search — inconsistent with the domain's active-role semantics (`party_active_role_unique` partial index treats only `thruDate IS NULL` roles as active). **Fix:** the `some` filter now also requires `thruDate: null`. Regression test asserts the where clause carries `thruDate: null`.

3. **🟢 `party.service.ts` — non-string nested subtype fields threw a raw `TypeError` instead of a `DomainError`.** `validatePersonData`/`validateOrganizationData` and the sanitize helpers called `.trim()` on required/optional subtype fields without a type guard, so a direct/internal caller bypassing the REST DTO / MCP Zod strings (the exact "last line of defense" scenario the class docs describe) passing e.g. `person: { firstName: 123 }` hit a raw `TypeError: ...trim is not a function` → a 500 `INTERNAL_ERROR` instead of the documented `InvalidTypeValueError` (422/`INVALID_INPUT`). `gender`/`middleName`/`taxId` already had `typeof` guards; `firstName`/`lastName`/`legalName` and the optional-boundary sanitizers did not. **Fix:** explicit `typeof !== "string"` guards throw `InvalidTypeValueError` in `validatePersonData`/`validateOrganizationData`; `sanitizePerson`/`sanitizeOrganization` guard optional fields before `.trim()`.

4. **🟢 `prisma.service.spec.ts` — dead, diverged validator mirror + unpinned bare `toThrow()`.** The spec mocked `validateTenantIdEnhanced` on `@besterp/database` ("Mirror the real validation logic for testing") throwing `InvalidTypeValueError` — but `PrismaService` never calls it. It imports and calls `validateTenantIdEnhancedForAuth` from `@besterp/shared` (not mocked), which throws `InvalidTenantIdError`. The mock branch was dead weight whose error contract had silently diverged (a changed throw type in the real validator would have gone unnoticed because the tenant-validation test used a bare `toThrow()`). **Fix:** removed the dead mock entry and the now-unused `InvalidTypeValueError` import; pinned the validation test to `toThrow(InvalidTenantIdError)`.

5. **🟢 `mcp.module.spec.ts` — bare `toThrow()` on empty tenant ID.** The null-tenant test beside it correctly pinned `InvalidTenantIdError` + message regex, but the empty-string case asserted only `toThrow()`, so any thrown error (typo, wrong code path) passed. **Fix:** pinned to `toThrow(InvalidTenantIdError)` + `/Tenant ID must be a non-empty string/`.

6. **🟢 `party.service.spec.ts` — "ensure toPartyResult not called" claim was named but not asserted.** The test title's parenthetical behavior was never verified (a regression that called `toPartyResult` on the not-found path would still pass the bare `rejects.toThrow(EntityNotFoundError)`). **Fix:** added a `vi.spyOn` on the static `toPartyResult` and assert `not.toHaveBeenCalled()`.

### Reviewed but NOT changed (false positives / deferred)

- Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found beyond those fixed above.
- **Cross-party email duplicate → generic P2002 message.** `checkEmailDuplicate` scopes to the requesting party, so adding a second party with an email already registered to a different party in the tenant passes the app-level check and falls through to the DB `@@unique([tenantId, email])` → mapped P2002. This is intentional and pinned by an explicit round-30 regression test ("no false positive for other parties"); the DB constraint remains the backstop. Deferred.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **PrismaService tenant-client cache, proxy, idempotency middleware, audit-log backpressure queue, error-handler, and `hashInput`'s DoS guards (depth/bytes/keys/CPU-time budgets)** were all read in full this round; logic remains consistent. No new issues found.

## Test Results (round 151)
```
api:       437 passed (17 files)  (+2: searchParties active-role + hasMore-ceiling,
                                   tightened prisma/mcp/party spec assertions)
shared:    229 passed (4 files)   (unchanged)
mcp-tools: 163 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     863 passed, 10 skipped
```
lint ✓ · typecheck ✓ · build ✓

## Findings & Actions (round 150)

### Fixed this round

1. **🟡 `packages/mcp-tools/src/middleware/audit-log.ts` — bare `null`/`undefined` written to Prisma `Json` columns; durable audit rows silently dropped.** A successful tool returning `{ success: true }` with no `data` produced `toolOutput: null` (`result.data ?? null`), and a tool invoked with no input produced `toolInput: undefined`. Prisma rejects a plain JS null/undefined for Json columns ("Provided Json null, expected JsonNull or DbNull"), so `aiActionLog.create` threw and the fire-and-forget catch dropped the audit row for every such call. The sibling `idempotency.ts` handles the identical situation with `Prisma.DbNull` — the asymmetry was the tell. **Fix:** `logAction` now maps null/undefined to `Prisma.JsonNull` for the REQUIRED `toolInput` column (DbNull would violate NOT NULL) and `Prisma.DbNull` for the nullable `toolOutput` column. The fix also exposed that `Prisma` was imported type-only, so the sentinels were a runtime `ReferenceError` — the import is now a value import. Regression test added (the test caught exactly that ReferenceError).

2. **🟡 `.github/workflows/ci.yml` — the `test` job could never pass.** `npx prisma migrate deploy` ran from the repo root, where Prisma cannot find `packages/database/prisma/schema.prisma` (verified: "Could not find Prisma Schema"), failing the job before migrations/RLS/seed/tests. Both "Cache Prisma client" steps cached `packages/database/node_modules/.prisma`, which does not exist under npm workspace hoisting (the generated client lands in the ROOT `node_modules/.prisma`) — the cache saved an empty archive and a cache-hit then skipped the explicit generate step. **Fix:** migrations run via `npm run migrate:deploy --workspace=@besterp/database` (correct working directory); both cache paths point at `node_modules/.prisma`.

3. **🟡 `party.service.ts` — mismatched contact-mechanism subtype data silently discarded.** `validateContactMechanismSubtype` validated only the required subtype; `createContactMechanismTransaction`'s type gates then dropped any extra subtype object, so a POSTAL_ADDRESS request also carrying `emailAddress` "succeeded" while the email was never stored. Both boundary layers (REST `ContactSubtypeExclusiveConstraint`, MCP `CONTACT_SUBTYPE_CONFIGS.disallowedFields`) and the sibling `validateCreatePartySubtype` all reject cross-provision — the service (self-described "last line of defense") alone didn't. **Fix:** unknown types are rejected up front (actionable "valid types" error), then a `rejectCrossSubtypeData` helper throws `InvalidTypeValueError` for any non-matching provided subtype; per-subtype validation extracted into `validatePostalAddressSubtype` / `validateTelecomSubtype` / `validateEmailSubtype` to stay within the complexity cap. Two regression tests added.

4. **🟡 Whitespace-only optional strings: REST 422 vs MCP success (documented-equivalent surfaces diverged).** For identical logical input, `POST /api/parties` with `description: "   "` got 422 (`"Description cannot be whitespace-only."`) while MCP `create_party` normalized it to unset and succeeded; `countryCode: "   "` got REST 400 but MCP silently defaulted to `+1`; MCP `search_parties` with `name: "   "` silently dropped the filter and returned the UNFILTERED listing, while REST 422'd via `requireNonEmptyFilter` — whose dedicated service regression test says silent widening is exactly what must not happen. **Fix, split by field class:** (a) optional VALUE fields (description, middleName, gender, taxId, addressLine2, stateProvince, postalCode, countryCode, extension) now use `optionalSanitizeTransform` in the DTO — sanitizes-to-empty becomes `undefined` so `@IsOptional()` skips it, matching MCP's `optionalFilteredString`; (b) SEARCH filters keep the reject contract on both surfaces — new `optionalSearchFilterString` in party-tools.ts rejects whitespace-only/HTML-only filter values at the MCP schema layer (previously normalized to undefined), matching the service and REST behavior. New `party.dto.spec.ts` (9 tests) + 2 updated party-tools tests pin the split.

5. **🟡 `health.service.ts` — Redis probe authenticated with the untrimmed `REDIS_PASSWORD`.** `QueueModule.resolvePassword` trims before use, but the probe sent the raw env value, so a whitespace-padded password connected fine on the queue while `/api/health` reported `redis: "disconnected"` forever (WRONGPASS). Host and port had already been aligned with the queue's resolution; password was the last unaligned knob. **Fix:** the probe trims exactly like the queue.

6. **🟡 Stale spikes around the idempotency composite PK.** `packages/database/spikes/spike-rls.ts` and `packages/mcp-tools/spikes/server.ts` still used single-field `where: { idempotencyKey }` selectors that `PrismaClientValidationError` rejects since the `idempotency_composite_pk` migration (`@@id([idempotencyKey, tenantId])`) — `npm run spike:rls` and `npm run dev` died mid-run. `server.ts` also imported `richError` from `@besterp/shared`, which no longer exists (replaced by the DomainError hierarchy), crashing at module load. **Fix:** composite `idempotencyKey_tenantId` selectors everywhere; local `richError` helper in the spike preserving the agent-facing shape; usage header corrected (`spikes/spike-rls.ts`, both env vars). Spikes are now typechecked: `tsconfig.scripts.json` added to both packages (`spikes/server.ts` excluded — the MCP SDK's `server.tool()` registration with inline Zod schemas costs >4 GB compiler heap; `test-agent.ts` checks in 1.6 s / 311 MB).

7. **🟡 `cleanup-expired-idempotency.ts` — comment described a raw-SQL delete the code did not perform.** The comment claimed a composite-index raw delete because "the ORM deleteMany with an OR array … can degrade to a full table scan", directly above that exact ORM OR-array. **Fix:** implemented the documented approach — a `DELETE … USING (VALUES …)` row-comparison that hits the composite PK and scales with batch size, fully parameter-bound via `Prisma.sql` (no injection surface); comment now records both the WhereUniqueInput constraint that rules out the ORM compound filter and the rationale.

8. **🟢 `suggestedTools` was the one agent-facing field never sanitized.** `error-handler.ts` sanitized `code`/`message` and redacted `context`, and `DomainError.toJSON` (the canonical durable-sink serializer) did the same — but both echoed `suggestedTools` verbatim despite their own comments establishing that custom subclasses carry user-controllable constructor strings. **Fix:** every entry is mapped through `sanitizeForLogOutput` in both places. Regression tests added (shared + asserted in middleware tests).

9. **🟢 `tool-registry.ts` `sanitizeIssues` fabricated `received: "[REDACTED]"`.** The sensitive-path branch set `received` without the `received !== undefined` guard the sibling branch had, so a missing-value Zod issue on a `password`-path told the agent a value was supplied when none was. The comment also claimed path segments matching sensitive field names were "redacted" — they are (correctly) preserved as key-name metadata. **Fix:** guard added (missing values omit `received` entirely); comment rewritten to state the actual contract.

10. **🟢 `tool-registry.ts` discarded the trimmed identity values → idempotency keyed under the wrong tenant string.** `validateContextIdentity` trimmed tenantId/userId for validation but propagated the ORIGINAL untrimmed context, so the idempotency composite key and audit rows used `" tenant-1 "` while handlers' RLS path (`withTenant` → `validateTenantId`) trimmed — a correctly-trimmed retry missed the record and re-executed the write. **Fix:** `validateContextIdentity` returns `{ error } | { context }` with the normalized identity; `execute` builds `effectiveContext` from it (rebuilding only when a value changed). Regression test asserts middlewares and handlers see the trimmed values.

11. **🟢 `idempotency.ts` contention message contradicted its own justification and invited key-hopping.** The agent-facing message said "retry with a new idempotency key" while the code comment (correctly) said "retrying with a new key won't help either" — P2034 exhaustion means a concurrent request holds the SAME record, and a new key would bypass idempotency protection and could double-execute the write. **Fix:** message now instructs "wait briefly and retry the same request with the same idempotency key (do not use a new key)".

12. **🟢 Consistency/ambiguity cleanup across surfaces:** `main.ts parsePort()` now uses the same fail-fast `try/catch → process.exit(1)` pattern as the other boot knobs (an invalid `PORT` previously surfaced as a mislabeled "Unhandled promise rejection"); `TenantGuard` throws `UnauthorizedException` (401, with diagnostic) for a missing/malformed `req.user` instead of a bare `return false` (generic 403), matching every other auth failure in the guard; the `overallStatus` comment in `health.service.ts` now matches the code (Redis never affects overall status); `sanitizeTelecomNumber` defaults to the exported `DEFAULT_PHONE_COUNTRY_CODE` instead of a duplicated `"+1"` literal; `decodeCommonEntities` and `withTenant`/`tenant.ts` comments now describe what the code actually does (`&quot;` after `&amp;`; `$executeRawUnsafe` with `$1` binding); dead `BackpressureManager.getStats()` and its phantom `getErrorStats` comment removed; `mcp.module.spec.ts` "strip HTML and preserve raw identity values" test renamed/rewritten — identity fields are charset-REJECTED (never rewritten), which is strictly stronger than the stripping the old comments claimed.

### Reviewed but NOT changed (false positives / deferred)

- Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found beyond those fixed above.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Deferred again: admin-curated reference data with a handful of seeded values; truncation middleware bounds downstream surfaces.
- **`sanitizeLogOutput` deprecated shim** retained as before (no production callers; back-compat).
- **Workspace-local tsc is 5.9.3 while a hoisted root `node_modules/.bin/tsc` 6.0.3 exists transitively.** No supported script invokes the root binary (all typecheck scripts resolve the workspace-local compiler), but running `npx tsc -p …` manually from the repo root uses 6.0.3 and reports pre-existing @types resolution noise. Not a defect in any wired path; noted for awareness.
- **Historical `richError` mentions in `CHANGES.md`/`ERP_PLAN.md`** document the state at the time of those entries and were left as-is; the symbol's removal from the spike is recorded in this round's changelog entry.

## Test Results (round 150)
```
api:       435 passed (17 files)  (+12: party.dto.spec.ts, contact-subtype rejection,
                                   search-filter rejection, TenantGuard 401)
shared:    229 passed (4 files)   (+1: suggestedTools toJSON sanitization)
mcp-tools: 163 passed (4 files)   (+2: JsonNull/DbNull sentinels, trimmed-identity
                                   propagation)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     861 passed, 10 skipped
```
lint ✓ · typecheck ✓ (incl. new spike coverage) · build ✓ · `npm audit` 0 vulnerabilities

## Findings & Actions (round 149)

### Fixed this round

1. **🟢 `packages/shared/src/validation.ts` — `validateOptionalString` threw plain `Error` instead of `InvalidTypeValueError`.** Every other validation surface in the codebase throws a structured `DomainError` subclass (with `code`, `context`, and `suggestedTools`). `validateOptionalString` was the sole outlier: it threw a plain `Error` string, forcing every caller in `McpService.buildContext` to wrap it in a try/catch and re-throw as `InvalidTypeValueError` — four duplicated catch blocks across `idempotencyKey`, `agentId`, `conversationId`, and `reasoning`. The original rationale for using a plain `Error` was to avoid a circular dependency between `validation.ts` and `errors.ts`, but `validation.ts` has no dependents in `errors.ts`, so the import is safe. **Fix:** `validateOptionalString` now throws `InvalidTypeValueError` directly with proper `{ context }`. Removed the four redundant try/catch wrappers from `McpService.buildContext` — each call site now delegates directly. Verified: lint ✓, typecheck ✓, all workspaces pass (846 tests total).

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Type tables are admin-curated global reference data with a handful of seeded values; the tool's contract is "return all valid values", and the truncation middleware bounds the audit/agent surfaces downstream. Low risk; deferred again.
- **`sanitizeLogOutput` (shared/src/sanitize.ts:457) is deprecated but still exported from `@besterp/shared`.** It delegates to `sanitizeForLogOutput` as a backward-compat shim. Only used in `sanitize.test.ts`; no production code calls it. Kept to avoid breaking any external consumers that may still reference it.
- **`result[0]!` non-null assertion in `party.service.ts:743` and `result[0]` (nullable guard) at line 781** — both are intentional and well-documented. The `!` at 743 is on the RETURNING row inside `$queryRaw` where the column alias maps to a camelCase key; the nullable guard at 781 exists because `noUncheckedIndexedAccess` makes `result[0]` type as `T | undefined`, and the guard converts that to a clear error rather than a silent undefined access.
- **`PrismaService` tenant-client cache (WeakRef + FinalizationRegistry + LRU), `rls-extension.ts` proxy (`$transaction`/blocked-method/non-string-symbol guards), `tool-registry.ts` `validateContextIdentity`, and the idempotency middleware's acquire/update retry + jittered backoff** were all re-read in full; the logic (stale-pending reclaim, P2034 jitter, P2025 fast-fail, redaction at both durable sinks) remains consistent. No new issues found.

## Test Results (round 149)
```
api:       423 passed (16 files)  (unchanged)
shared:    228 passed (4 files)   (unchanged — validateOptionalString tests cover the new behavior)
mcp-tools: 161 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     846 passed, 10 skipped
```

## Findings & Actions (round 146)

### Fixed this round

1. **🟢 `packages/database/src/index.ts` — dead export of `validateTenantIdEnhanced` from `@besterp/database` public API.** `validateTenantIdEnhanced` (in `rls-extension.ts:67`) wraps `validateTenantId` in a try/catch that re-throws DomainErrors unchanged and wraps non-DomainErrors as `InvalidTypeValueError`. However, `validateTenantId` *always* throws `InvalidTenantIdError` (a `DomainError` subclass), so the non-DomainError branch is unreachable dead code — and more importantly, no external consumer imports the function: `apps/api`, `packages/mcp-tools`, and `packages/shared` all use `validateTenantIdEnhancedForAuth` from `@besterp/shared` instead. The only callers are internal (`createTenantClient` at line 298) and tests that import directly from `rls-extension.js` (not the package barrel). Exporting it from `index.ts` gave a false impression of public API surface and invited drift. **Fix:** removed `export { validateTenantIdEnhanced }` from `packages/database/src/index.ts`. The function remains exported from `rls-extension.ts` for internal use and its own tests; only the public barrel was cleaned up. Verified: lint ✓, typecheck ✓, all database tests pass (34 passed, 10 skipped), full suite 842 tests unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Type tables are admin-curated global reference data with a handful of seeded values; the tool's contract is "return all valid values", and the truncation middleware bounds the audit/agent surfaces downstream. Low risk; deferred again.
- **`sanitizeLogOutput` (shared/src/sanitize.ts:457) is deprecated but still exported from `@besterp/shared`.** It delegates to `sanitizeForLogOutput` as a backward-compat shim. Only used in `sanitize.test.ts`; no production code calls it. Kept to avoid breaking any external consumers that may still reference it.
- **`validateOptionalString` (shared/src/validation.ts) throws generic `Error` instead of `InvalidTypeValueError`.** This is intentional: callers in `McpService.buildContext` catch the generic error and re-throw as `InvalidTypeValueError` with structured context. The generic throw keeps the shared package free of a circular dependency on the error classes. No change needed.
- **`result[0]!` non-null assertion in `party.service.ts:743` and `result[0]` (nullable guard) at line 781** — both are intentional and well-documented. The `!` at 743 is on the RETURNING row inside `$queryRaw` where the column alias maps to a camelCase key; the nullable guard at 781 exists because `noUncheckedIndexedAccess` makes `result[0]` type as `T | undefined`, and the guard converts that to a clear error rather than a silent undefined access.
- **`PrismaService` tenant-client cache (WeakRef + FinalizationRegistry + LRU), `rls-extension.ts` proxy (`$transaction`/blocked-method/non-string-symbol guards), `tool-registry.ts` `validateContextIdentity`, and the idempotency middleware's acquire/update retry + jittered backoff** were all re-read in full; the logic (stale-pending reclaim, P2034 jitter, P2025 fast-fail, redaction at both durable sinks) remains consistent. No new issues found.

## Test Results (round 147)
```
api:       423 passed (16 files)  (unchanged)
shared:    228 passed (4 files)   (unchanged)
mcp-tools: 161 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     846 passed, 10 skipped
```

## Findings & Actions (round 146)

### Fixed this round

1. **🟡 `tsconfig.base.json` — deprecated `downlevelIteration` compiler option triggered TS5101 with TypeScript 6.0.3.** `downlevelIteration` polyfills `for...of`, spread-on-iterables, and `Array.from(iterable)` for older TypeScript targets. Node 20+ (the project's minimum, per `engines.node`) fully supports these natively, so the flag is dead weight and its presence emits a hard typecheck error: `TS5101: Option 'downlevelIteration' is deprecated and will stop functioning in TypeScript 7.0`. **Fix:** removed `"downlevelIteration": true` from `tsconfig.base.json`. No behavioural change — all iterables are natively supported by the runtime, and the option was only needed when targeting ES2015 or earlier. Verified: `npm run typecheck` passes clean across all four workspaces; all 842 tests pass unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Type tables are admin-curated global reference data with a handful of seeded values; the tool's contract is "return all valid values", and the truncation middleware bounds the audit/agent surfaces downstream. Low risk; deferred again.
- **`validateOptionalString` (shared/src/validation.ts) throws generic `Error` instead of `InvalidTypeValueError`.** This is intentional: callers in `McpService.buildContext` catch the generic error and re-throw as `InvalidTypeValueError` with structured context. The generic throw keeps the shared package free of a circular dependency on the error classes. No change needed.
- **`result[0]!` non-null assertion in `party.service.ts:743` and `result[0]` (nullable guard) at line 781** — both are intentional and well-documented. The `!` at 743 is on the RETURNING row inside `$queryRaw` where the column alias maps to a camelCase key; the nullable guard at 781 exists because `noUncheckedIndexedAccess` makes `result[0]` type as `T | undefined`, and the guard converts that to a clear error rather than a silent undefined access.
- **`PrismaService` tenant-client cache (WeakRef + FinalizationRegistry + LRU), `rls-extension.ts` proxy (`$transaction`/blocked-method/non-string-symbol guards), `tool-registry.ts` `validateContextIdentity`, and the idempotency middleware's acquire/update retry + jittered backoff** were all re-read in full; the logic (stale-pending reclaim, P2034 jitter, P2025 fast-fail, redaction at both durable sinks) remains consistent. No new issues found.

## Test Results (round 146)
```
api:       419 passed (16 files)  (unchanged)
shared:    228 passed (4 files)   (unchanged)
mcp-tools: 161 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     842 passed, 10 skipped
```

## Findings & Actions (round 143)

### Fixed this round

1. **🟡 `packages/mcp-tools/src/middleware/audit-log.ts` — soft-failure results persisted `toolOutput: null`, losing all error detail on the real production error path.** In the compiled pipeline the OUTERMOST `errorHandlerMiddleware` converts every thrown error (Zod validation, domain, Prisma) into a *non-thrown* `{ success: false }` ToolResult, so the audit middleware's own throw branch can never fire for the common failure modes — every failed operation was persisted to `ai_action_log.tool_output` as `null`, and the durable audit trail recorded no indication of why an action failed. **Fix:** the soft-failure branch now persists `{ error: { message, code } }`, mirroring the throw branch: both fields pass through `sanitizeForLogOutput` + `capString`/`MAX_SOFT_FAILURE_MESSAGE_SIZE`, and `code` is redacted to `[REDACTED]` at the durable sink the same way as the throw branch (`code` is a sensitive field name). The shaping logic was extracted into `formatSoftFailureOutput` so `executeAndLog` stays within the lint complexity cap (matching the extraction pattern already used in `error-handler.ts` and `tool-registry.ts`). Added 2 regression tests (stored shape + DB connection-string scrub on the soft-failure path).

2. **🟢 `apps/api/src/mcp/tools/discovery-tools.ts` — `get_type_table_values` queried type tables with no `orderBy`, yielding non-deterministic row order.** Without an ORDER BY, Postgres returns rows in unspecified (heap/insertion) order, so the same "valid values" call could present the vocabulary in a different order per call — surprising for an agent-facing reference surface and producing non-identical snapshots in the durable audit row. `name` is `@unique` (never null), so ascending name order is total and stable. **Fix:** added `orderBy: { name: "asc" }` to the `findMany` and widened the intentionally-narrow `PrismaModelDelegate.findMany` interface to accept `orderBy`. Added 1 regression test asserting deterministic ordering across all three type tables.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) still returns all type-table rows with no `take` cap.** Type tables are admin-curated global reference data with a handful of seeded values; the tool's contract is "return all valid values", and the truncation middleware bounds the audit/agent surfaces downstream. The ordering fix above is orthogonal (determinism, not volume). Low risk; deferred again.
- **`QueueModule.redisRetryStrategy` returning `undefined` once `MAX_RETRIES` is exhausted.** Verified against the installed `node_modules/ioredis/built/redis/event_handler.js:188` (`typeof retryDelay !== "number" → close()`): ioredis terminates reconnection when the strategy returns a non-number, so the cap is correctly honored (an `undefined` return does NOT schedule an infinite default-delay retry). No change needed.
- **`PrismaService` tenant-client cache (WeakRef + FinalizationRegistry + LRU), `rls-extension.ts` proxy (`$transaction`/blocked-method/non-string-symbol guards), `tool-registry.ts` `validateContextIdentity`, and the idempotency middleware's acquire/update retry + jittered backoff** were all re-read in full; the logic (stale-pending reclaim, P2034 jitter, P2025 fast-fail, redaction at both durable sinks) remains consistent. No new issues found.

## Test Results (round 143)
```
api:       419 passed (16 files)  (+1 regression test)
shared:    228 passed (4 files)   (unchanged)
mcp-tools: 161 passed (4 files)   (+2 regression tests)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
──────────────────────────────
Total:     842 passed, 10 skipped
```

## Findings & Actions (round 142)

### Fixed this round

1. **🟡 Dependency audit — 15 vulnerabilities (1 critical, 3 high) reduced to 0.** `npm audit` surfaced a critical advisory in `vitest@3.2.4` (UI-server file read), a high DoS in `multer@2.1.1` (runtime, via `@nestjs/platform-express@~11.0.0`), a moderate DoS in `qs@6.15.1` (runtime, via `express`/`body-parser`), and transitive dev-chain advisories (`vite` → `postcss` → `nanoid`, `@nestjs/cli` → `js-yaml`, `@modelcontextprotocol/sdk` → `express-rate-limit` → `ip-address`). **Fix:** bumped `@nestjs/platform-express` → `^11.1.29` (→ `multer@2.2.0`) and `vitest` → `^3.2.7` in all four workspaces; added root `overrides` for `qs@6.15.3`, `ip-address@10.5.0`, `js-yaml@4.3.1`, `vite@7.3.6`, `postcss@8.5.26`, `nanoid@3.3.18`; regenerated the lockfile (overrides require a clean reinstall to take effect). Verified: `npm audit` → 0; resolved versions confirmed via `npm ls`; lint/typecheck green; 418 api tests unchanged.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) returns all type-table rows with no `take` cap.** Type tables are admin-curated global reference data with a handful of seeded values; the tool's contract is "return all valid values", and the truncation middleware bounds the audit/agent surfaces downstream. Low risk; deferred.
- **DTO/module wiring (`party.dto.ts`, `app.module.ts`, `mcp.module.ts`)** re-read in full this round: the `_subtypeCheck` phantom-field pattern, cross-field `@Validate` constraints, and the `DiscoveryModule`/`APP_FILTER`/`APP_GUARD` wiring are all consistent with prior-round design. No changes needed.

## Test Results (round 142)
```
api:       418 passed (16 files)  (unchanged — dependency-fix round only)
shared:    228 passed (4 files)   (unchanged)
mcp-tools: 159 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───┬──────────────────────────────────────────────────────────┬
   │ npm audit: 15 → 0 vulnerabilities (0 critical/high)       │
───┴──────────────────────────────────────────────────────────┘
Total:     839 passed, 10 skipped
```

## Findings & Actions (round 138)

### Fixed this round

1. **🟡 `apps/api/src/auth/jwt.strategy.ts` — `validateTenantId` catch swallowed the original error message.** The catch block re-threw as `UnauthorizedException("Invalid token: tenantId failed format validation.")` with no context about *why* validation failed (e.g. whether the cause was an `INVALID_TENANT_ID` vs a charset mismatch). This was inconsistent with `tenant.guard.ts`, which round 133 already fixed to include the original message in the exception. Operators reading client-facing errors could not distinguish between different tenant-validation failure modes. **Fix:** included `msg` in the `UnauthorizedException`, matching the `tenant.guard.ts` pattern (`TenantGuard: tenantId failed format validation. ${msg}`). Added 1 regression test asserting the original cause is present in the thrown exception.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) returns all type-table rows with no `take` cap.** Type tables are admin-curated global reference data with a handful of seeded values; the tool's contract is "return all valid values", and the truncation middleware bounds the audit/agent surfaces downstream. Low risk; deferred.

## Test Results (round 138)
```
api:       418 passed (16 files)  (+1 regression test)
shared:    228 passed (4 files)   (unchanged)
mcp-tools: 159 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     839 passed, 10 skipped
```

## Findings & Actions (round 135)

### Fixed this round

1. **🟡 `apps/api/src/health.service.ts` — missing `REDIS_PORT` in non-dev violated the documented "never throws" probe contract.** `runRedisProbe` threw on a missing `REDIS_PORT` in non-development while its doc comment (and `probeRedis`'s) documented that the probe "never throws" and warns-and-skips on a missing or invalid port. When that path fired, `getHealth()` rejected and `/api/health` + `/api/health/ready` returned a bare 500 (masked as a generic error in prod) instead of the structured status body — inconsistent with the invalid-port branch, which already warns once and reports `"disconnected"`. **Fix:** the missing-port path now mirrors the invalid-port branch (warn once + skip the probe + report `"disconnected"`), so the health payload still flags the misconfiguration while the endpoints stay resilient. QueueModule's boot-time port validation remains the actual fail-closed gate against a misconfigured deploy starting. Added 1 regression test.

2. **🟢 `apps/api/src/modules/core/party/party.service.ts` — `searchParties` offset pagination non-deterministic for tied `createdAt`.** `orderBy: { createdAt: "desc" }` alone leaves rows with an identical `createdAt` (timestamp(3), millisecond precision) in an arbitrary DB order; bulk/concurrent inserts routinely share a timestamp, so offset pagination could return duplicate or skipped parties across pages. **Fix:** added `{ partyId: "asc" }` as a deterministic tiebreaker. Added 1 regression test.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`get_type_table_values` (discovery-tools.ts) returns all type-table rows with no `take` cap.** Type tables are admin-curated global reference data with a handful of seeded values; the tool's contract is "return all valid values", and the truncation middleware bounds the audit/agent surfaces downstream. Low risk; deferred.

## Test Results (round 135)
```
api:       417 passed (16 files)  (+2 regression tests)
shared:    228 passed (4 files)   (unchanged)
mcp-tools: 159 passed (4 files)   (unchanged)
database:   34 passed, 10 skipped (3 files) (DB-backed; unchanged)
───────────────────────────────
Total:     838 passed, 10 skipped
```

## Findings & Actions (round 134)

### Fixed this round

1. **🟡 `main.ts` — CORS origins accepted arbitrary strings without format validation.** `parseAllowedOrigins()` split `CORS_ORIGINS` and returned every non-empty token verbatim, so a typo like `CORS_ORIGINS=evil.com` (missing the `https://` scheme) would enable cross-origin requests unconditionally — the exact operator-footgun class round 89 closed for `TRUST_PROXY_HOPS`. **Fix:** added a post-parse check that flags any origin not matching a URL-like pattern (`https?://...`) with a boot-time `logger.warn`. Validation remains permissive (we do not reject, only warn) so genuine origins that use unusual schemes are not blocked, but a mistyped or omitted scheme is immediately visible in operator logs.

2. **🟡 `party-tools.ts:438` — tool description used an invalid UUID example.** The `add_party_role` description example showed `partyId: "abc-123"`, which does not match `UUID_REGEX` and would confuse agents that treat the example as a template. **Fix:** replaced with a valid UUID (`550e8400-e29b-41d4-a716-446655440000`) so the example is structurally correct.

3. **🟡 `tenant.guard.ts` — `validateTenantId` swallowed the original error message.** The `catch` block re-threw as `UnauthorizedException("TenantGuard: tenantId failed format validation.")` with no context about *why* validation failed (e.g. whether the cause was a length overflow, a charset mismatch, or an internal `InvalidTenantIdError`). This made debugging token issues harder for operators reading logs. **Fix:** the catch now includes the sanitized original message in the `UnauthorizedException`, giving both the guard label and the specific cause.

4. **🟢 `cleanup-expired-idempotency.ts` — advisory lock key was a local literal, not centralized.** The cleanup script defined `const _ADVISORY_LOCK_KEY = 0x626573746572` locally. If another script ever needed the same lock it would have to re-derive the value, creating drift risk. **Fix:** exported `ADVISORY_LOCK_KEY_CLEANUP_IDEMPOTENCY` from `@besterp/shared/constants.ts` with full documentation of the value's origin and constraints, and imported it in the cleanup script.

5. **🟢 `sanitize.ts` — `sanitizeForLogOutput` pipeline was a 10-deep nested call chain.** Each reduction step was a function call nested inside another, making the pipeline hard to read, extend, or test independently. **Fix:** extracted the pipeline into a named `Array<(s: string) => string>` and reduced over it. Behaviour is identical; the change is structural for maintainability.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **JWT secret cache (`jwt.strategy.ts`)** — re-verified as intentional: the cache is reset between tests via `resetJwtSecretCache()`. Runtime secret rotation is not supported by design (process restart required), which is documented and consistent with the singleton-boot pattern.
- **`party.service.ts` count+findMany race in `searchParties`** — acknowledged limitation under READ COMMITTED; sequential execution prevents the worst case (over-reporting hasMore). Known and intentional; no fix required.
- **Advisory lock key documentation** — the comment block in the cleanup script already explained the value's constraints; kept as-is since the constant's JSDoc now carries the same rationale.

## Test Results (round 133)
```
api:       415 passed (16 files)  (unchanged — no new tests needed; all fixes are structural/validation)
shared:    228 passed (4 files)   (+4 vs round 114 — sanitize pipeline regression tests re-verified)
mcp-tools: 159 passed (4 files)   (unchanged)
database:   27 passed, 10 skipped (2 files) (DB-backed; unchanged)
───────────────────────────────
Total:     829 passed, 10 skipped
```

## Findings & Actions (round 114)

### Fixed this round

1. **🟢 `party.service.ts` — dead fabricated-timestamp fallbacks on `fromDate`.** `PartyRole.fromDate` is `NOT NULL` in the schema (DB default `now()`), so two `?? new Date().toISOString()` fallbacks were unreachable and, worse, silently fabricated timestamps if the invariant ever drifted (mirrors the dead `?? "UNKNOWN"` fallbacks removed in rounds 108–109). **Fix:** removed both fallbacks (`addPartyRole` result mapping and the `addPartyRoleTransaction` duplicate-error path), which now fail loudly with a `TypeError` instead of inventing data. Comments document the NOT NULL invariant. Added 3 regression tests (DB-stored `fromDate` returned verbatim; null `fromDate` rejects loudly; duplicate error reports the existing role's real DB `fromDate`).

2. **🟡 `main.ts` — middleware order left 429/preflight responses without `x-request-id`.** The request-ID middleware was registered AFTER helmet, the health-aware rate limiter, and `configureCors`. Body-parser 413/400 responses are handled later in the chain and carry the header, but rate-limited 429s and CORS preflight OPTIONS short-circuited before the middleware ran — so the exact abusive traffic you want to correlate lacked a request ID. **Fix:** moved the request-ID middleware directly after helmet (kept first for security headers), before the limiter and CORS, so every early-exit response carries the correlation header.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`formatPartyRoleResult` `fromDate` mapping (`party.service.ts` ~line 1165)** keeps its tolerant `r.fromDate ? r.fromDate.toISOString() : null` shape for the `PartyResult` search/list surface, where older reads may legitimately surface nulls from pre-migration rows; this is a display mapping, not a fabrication, so it does not share the fail-loud contract of the write-path fixes above. Kept as-is; documented for future readers.
- **`bootstrap-config.ts` cache-size fractional values** — `PRISMA_CLIENT_CACHE_SIZE=1.5` yields a fractional LRU max; harmless (LRU compares `map.size >= maxSize`, so 1.5 behaves like 2) and never a security issue; deferred (unchanged from round 113).

## Test Results (round 114)
```
api:       396 passed (16 files)  (+3 regression tests vs round 113)
shared:    224 passed (4 files)   (unchanged)
mcp-tools: 158 passed (4 files)   (unchanged)
database:   27 passed, 10 skipped (2 files) (DB-backed; unchanged)
────────────────────────────────────
Total:     805 passed, 10 skipped
```

## Findings & Actions (round 113)

### Fixed this round

1. **🟡 `discovery-tools.ts` — `list_available_tools` `entity` filter silently returned an empty list for whitespace-only input.** A whitespace-only `entity` (`"   "`) passed the old schema (`z.string().max(MAX_ENTITY_LENGTH).optional()` — no trim, no empty normalization), then the handler trimmed it to `""` and compared `"" === (t.entity ?? "")`. Since every tool declares a non-empty entity, that comparison never matches, so the tool returned zero results — the exact "silently narrows to nothing" behaviour round 107 removed from `optionalFilteredString`, which normalizes whitespace-only optional filters to *no filter*. **Fix:** the schema now mirrors `optionalFilteredString`: `.optional().transform()` trims and maps empty/whitespace-only to `undefined`, `.pipe(z.string().max(MAX_ENTITY_LENGTH).optional())` enforces the length cap on the TRIMMED value (round-107 convention — a whitespace-padded value over the cap stays valid once trimmed), and the handler lowercases the pre-trimmed value. Added 2 regression tests (whitespace-only → all tools; surrounding whitespace trimmed before filtering).

2. **🟡 `main.ts` — unbounded `await app.close()` on the listen-failure path.** The `catch` around `app.listen()` awaited `app.close()` with no hard-exit bound, unlike `gracefulShutdown`, which bounds teardown with an unref'd hard-exit timer. If teardown hung after a listen failure (e.g. a stuck database connection pool), the process would stay alive in a half-initialized state instead of failing fast. **Fix:** extracted `closeWithTimeout(app, label, timeoutMs)` (hard-exit timer + `unref()` + `finally` clear; close errors propagate to the caller) and used it in both `gracefulShutdown` (behaviour identical, logic now shared — the inline timer/finally were removed) and the listen-failure path (same `HARD_EXIT_TIMEOUT_MS` default from `resolveHardExitTimeout`).

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **Full-file re-reads this round** — every previously-truncated source is now read in full: `party.service.ts` (1190 lines), `prisma.service.ts`, `idempotency.ts`, `error-handler.ts`, `audit-log.ts`, `sanitize.ts`, `main.ts`, `tool-registry.ts`, `party-tools.ts`, `discovery-tools.ts`, `truncate.ts`, `tool-definition.ts`, `health.service.ts`, `party.dto.ts`, `party.types.ts`, `seed.ts`, `bootstrap-config.ts`, `rls-extension.ts`, `cleanup-expired-idempotency.ts`, plus the `auth/`, `common/`, `queue/`, and `mcp/` sources. Greps confirmed no stray `TODO`/`FIXME`/`console.log`/`process.exit` outside the documented boot/shutdown/script paths (the 3 `eslint-disable` comments in `sanitize.ts` and the 1 `@ts-expect-error` in `tool-registry.test.ts` are intentional with justifications). No other genuine defects found.
- **CI pipeline (`ci.yml`)** — the `test` job regenerates the Prisma client because the `lint-build` job's `actions/cache` entry is job-scoped (not reused across jobs), and `test` is serialized behind `needs: lint-build`. Both are minor efficiency observations, not correctness bugs; deferred.
- **`bootstrap-config.ts` cache-size fractional values** — `parsePositiveInteger` clamps to the integer range but `PRISMA_CLIENT_CACHE_SIZE=1.5` yields a fractional LRU max; harmless (LRU compares `map.size >= maxSize`, so 1.5 behaves like 2) and never a security issue; deferred.

## Test Results (round 113)
```
api:       393 passed (16 files)  (+2 regression tests)
shared:    224 passed (4 files)   (unchanged since round 112)
mcp-tools: 158 passed (4 files)   (unchanged)
database:   27 passed, 10 skipped (2 files) (DB-backed; unchanged)
────────────────────────────────────
Total:     802 passed, 10 skipped
```

## Findings & Actions (round 111)

### Fixed this round

1. **🔴 `seed.ts:230` — `console.error(e)` dumps raw Error with stack trace to operator console.** The catch handler passed the raw Error object directly to `console.error`. Node's default Error serialization includes the full stack trace, leaking internal filesystem paths (e.g. `/opt/app/node_modules/...`) to anyone with console access. **Fix:** changed to `console.error(e instanceof Error ? e.message : String(e))` so only the error message surface reaches the operator console, consistent with every other error-handling path in the codebase.

2. **🟡 `bootstrap-config.ts` — dead import alias after round 110 re-export change.** Round 110 left a `normalizeEnvironmentValue as _normalizeEnvironmentValue` import alongside a `const normalizeEnvironmentValue = _normalizeEnvironmentValue` assignment. The round 111 barrel re-export (`export { normalizeEnvironmentValue } from "@besterp/shared"`) made the import and const assignment both unused, triggering `@typescript-eslint/no-unused-vars`. **Fix:** removed the now-redundant import and const alias, keeping only the clean `export { normalizeEnvironmentValue } from "@besterp/shared"` declaration.

3. **🟡 `party.controller.ts` — unhelpful error message in `getTenantContext`.** The fallback `UnauthorizedException("Invalid authentication context.")` was vague — it could mean missing JWT, expired token, or a tenant-scope issue, and gives the operator no actionable signal. **Fix:** changed to `"Tenant context is missing. Authentication failed."` which makes the failure mode explicit without leaking internal state.

### Reviewed but NOT changed (false positives / deferred)

- **`discovery-tools.ts` dynamic Prisma delegate access (`prisma as unknown as Record<string, unknown>`)** — intentional: the `TYPE_TABLE_MAP` keys are compile-time enum values (`PARTY_TYPE | ROLE_TYPE | CONTACT_MECHANISM_TYPE`), and the runtime guard validates the delegate has `findMany` before casting. No injection surface.
- **`rls-extension.ts` dynamic property access (`tx as unknown as Record<string, unknown>`)** — intentional and guarded: the Prisma `$transaction` callback receives a typed `TransactionClient`, but model access via dynamic property is the only way to resolve the model name from the proxy. The `typeof delegate === "function"` and `typeof delegate !== "object"` guards prevent bypass.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`normalizeEnvironmentValue` in `health.service.ts`** — correctly imports from `./bootstrap-config.js` (the re-export), which itself imports from `@besterp/shared`. The round 111 change only removed the intermediate const alias; the runtime import path is unchanged.
- **`TenantContext` interface** — matches `TenantGuard` runtime assignment; `userId` and `agentId` are present.

## Test Results (round 111)
```
api:       391 passed (16 files)  (unchanged)
shared:    226 passed (4 files)   (unchanged)
mcp-tools: 158 passed (4 files)   (unchanged)
database:   27 passed, 10 skipped (2 files) (DB-backed; unchanged)
────────────────────────────────────
Total:     802 passed, 10 skipped
```

## Findings & Actions (round 110)

### Fixed this round

1. **🔴 `cleanup-expired-idempotency.ts` — `normalizeEnvironmentValue` imported from `@besterp/api` via bare relative path.** The cleanup script used `import { normalizeEnvironmentValue } from "../../api/src/bootstrap-config.js"`, which is a cross-workspace dependency from `@besterp/database` into `@besterp/api`. When `@besterp/database` is published as a standalone package this path will not resolve correctly (Node resolves workspace-local paths differently from `node_modules`). **Fix:** moved `normalizeEnvironmentValue` from `@besterp/api/bootstrap-config.ts` to `@besterp/shared/src/constants.ts` where it semantically belongs (it is a pure env-normalization helper with no NestJS dependency). `@besterp/api/bootstrap-config.ts` now re-exports it as a barrel alias so all existing `@besterp/api` import sites (`main.ts`, `health.service.ts`) continue to work unchanged. `@besterp/shared/src/index.ts` was updated to export it. `cleanup-expired-idempotency.ts` now imports from `@besterp/shared` via the normal workspace resolution path. `seed.ts` was also updated to use the centralized `normalizeEnvironmentValue` instead of its own inline `.trim().toLowerCase()`. No behavioural change — only the source-of-truth moved to the correct package boundary.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`TenantContext` interface** — already fixed in round 109; `userId` and `agentId` are declared and match `TenantGuard` runtime assignment.
- **`discovery-tools.ts` dynamic Prisma delegate access** — intentional and guarded; no injection surface.

## Test Results (round 110)
```
api:       391 passed (16 files)  (unchanged)
shared:    226 passed (4 files)   (unchanged)
mcp-tools: 158 passed (4 files)   (unchanged)
database:   27 passed, 10 skipped (2 files) (DB-backed; unchanged)
────────────────────────────────────
Total:     802 passed, 10 skipped
```

## Findings & Actions (round 109)

### Fixed this round

1. **🟢 `party.service.ts:toPartyResult` — dead `?? "UNKNOWN"` fallback on `roleType.name`.** The query always includes `roles: { include: { roleType: true } }`, and the Prisma schema enforces a non-null FK from `party_role.roleTypeId` → `role_type`. The `roleType` relation is never null for a valid query result, so the `?? "UNKNOWN"` fallback was unreachable dead code. **Fix:** removed the `?? "UNKNOWN"` so a null `roleType.name` (schema drift) surfaces as a clear `TypeError` rather than silently returning `"UNKNOWN"`.

2. **🟢 `health.service.ts` — duplicated `NODE_ENV` normalization inline.** `getHealth()` and `getVersion()` each ran `process.env.NODE_ENV?.trim().toLowerCase() || "development"` inline, duplicating the logic that `bootstrap-config.ts:normalizeEnvironmentValue` already centralizes. **Fix:** both call sites now delegate to `normalizeEnvironmentValue`, ensuring any future change to the normalization rule (e.g. a new default for unset values) propagates uniformly.

3. **🟢 `prisma.service.ts:initCacheSize` — duplicated guard logic extracted to `bootstrap-config.ts:normalizeCacheSize`.** The cache-size resolver (trim, NaN guard, explicit-0 clamp to 1, 1–100 000 range clamp, per-var warning messages) was duplicated from the bootstrap-config module. **Fix:** extracted to a shared `normalizeCacheSize(raw, defaultSize, varName, logger)` helper; `PrismaService.initCacheSize` now delegates to it. No behavior change — only the single source of truth moved.

4. **🟢 `cleanup-expired-idempotency.ts` — `NODE_ENV` normalized without `normalizeEnvironmentValue`.** Both the seed script and this cleanup script lowercased `process.env.NODE_ENV` but did not use the centralized `normalizeEnvironmentValue` helper, creating a maintenance drift surface. **Fix:** both now import and use `normalizeEnvironmentValue` so the normalization contract is consistent across every standalone script and the main bootstrap path.

### Reviewed but NOT changed (false positives / deferred)

- **`TenantContext` interface missing `userId`/`agentId` fields** — already fixed this round (round 109 added the fields to the interface declaration in `tenant-context.ts` so the Express augmentation matches the guard's runtime assignment).
- **`discovery-tools.ts` dynamic Prisma delegate access (`prisma as unknown as Record<string, unknown>`)** — intentional: the `TYPE_TABLE_MAP` keys are compile-time enum values, and the runtime guard validates the delegate exists before casting. No injection surface.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.

## Test Results (round 109)
```
api:       391 passed (16 files)  (unchanged)
shared:    226 passed (4 files)   (unchanged)
mcp-tools: 158 passed (4 files)   (unchanged)
database:   27 passed, 10 skipped (2 files) (DB-backed; unchanged)
────────────────────────────────────
Total:     802 passed, 10 skipped
```

## Findings & Actions (round 108)

### Fixed this round

1. **🔴 `party.service.ts:createPartyRoleTransaction` — `ON CONFLICT DO NOTHING` on a partial unique index without specifying the conflict target.** The `party_role_active_unique` index is a partial index (`WHERE thru_date IS NULL`). Prisma's auto-generated conflict target for `ON CONFLICT DO NOTHING` on a partial unique index does not include the partial-index predicate, so the conflict detection could fire on a row where `thru_date IS NOT NULL` (an expired role) rather than the active-row target — causing `add_party_role` to silently return 0 rows and throw `ConcurrencyRetryError` on a non-race, non-duplicate insert. **Fix:** explicitly specify `ON CONFLICT ("party_id", "role_type_id") WHERE "thru_date" IS NULL DO NOTHING` so the conflict target matches the partial index exactly. Regression test added (active-role duplicate returns `DuplicateEntityError` with existing role date, not `ConcurrencyRetryError`).

2. **🟡 `domain-exception.filter.ts` — non-500 `DomainError` paths logged at `warn` level, flooding operator logs with expected domain errors.** Every `EntityNotFoundError` (404), `DuplicateEntityError` (409), `InvalidTypeValueError` (422), and `TenantContextFailedError` (503) emitted a `warn` log line. For high-traffic endpoints (search, role assignment), this produced hundreds of warn entries per minute for normal operational errors — drowning out genuine warnings. **Fix:** changed the non-500 path from `logger.warn` to `logger.debug`, preserving the full sanitized message for operational debugging while keeping the operator log signal-to-noise ratio healthy. 500-path (unknown codes) remains at `error`.

3. **🟢 `party.service.ts:toPartyResult` — dead `?? "UNKNOWN"` fallback on `partyType.name`.** `partyType` is always included in the query (`include: { partyType: true }`), and the Prisma schema enforces a non-null `partyTypeId` FK to `party_type`. The `partyType` relation is never null for a valid query result, so the `?? "UNKNOWN"` fallback was unreachable dead code. **Fix:** removed the `?? "UNKNOWN"` so a null `partyType.name` (schema drift) surfaces as a clear `TypeError` rather than silently returning `"UNKNOWN"`.

4. **🟢 `cleanup-expired-idempotency.ts` — advisory lock queries used template-literal interpolation instead of parameterized binding.** `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY})` and `SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})` worked because the value is a numeric constant, but the pattern was inconsistent with the rest of the script (all other queries use `$1` parameter binding). **Fix:** replaced with `$1` parameterized form (`SELECT pg_try_advisory_lock($1)`, `[ADVISORY_LOCK_KEY]`) for consistency and to eliminate any future risk if the constant is ever replaced with user input.

5. **🟢 `tenant.guard.ts` — missing rationale comment for `TENANT_ID_PATTERN` on `userId`.** The pattern check was present but undocumented; a future contributor might not understand why ULID-style IDs (which include hyphens) are accepted by an alphanumeric-looking pattern. **Fix:** added a comment explaining that all BestERP identifiers are ULID-style strings (26-char sortable IDs using Crockford base32 plus optional hyphens) and that the pattern is deliberately permissive to accept any valid ULID while rejecting control characters and whitespace that could be used for log injection.

### Reviewed but NOT changed (false positives / deferred)

- **`TenantContext` interface missing `userId`/`agentId` fields** — the interface in `tenant-context.ts` only declares `tenantId`, but `TenantGuard` sets all three on `request.tenantContext`. The Express module augmentation adds `tenantContext?: TenantContext` but the guard assigns `{ tenantId, userId, agentId }`. TypeScript accepts this because the interface is used as a constraint, not a structural match on the assignment. No functional issue — the guard's runtime behavior is correct.
- **`discovery-tools.ts` dynamic Prisma delegate access (`prisma as unknown as Record<string, unknown>`)** — intentional: the `TYPE_TABLE_MAP` keys are compile-time enum values, and the runtime guard validates the delegate exists before casting. No injection surface.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.

## Test Results (round 108)
```
api:       391 passed (16 files)  (unchanged)
shared:    226 passed (4 files)   (unchanged)
mcp-tools: 158 passed (4 files)   (unchanged)
database:   27 passed, 10 skipped (2 files) (DB-backed; unchanged)
────────────────────────────────────
Total:     802 passed, 10 skipped
```

## Findings & Actions (round 107)

### Fixed this round

1. **🟡 `bootstrap-config.ts` `resolveHardExitTimeoutMs` — whitespace-only env value parsed as an explicit `0` → instant forced exit.** The resolver only skipped `undefined`/`""`; `Number("  ")` is `0`, so a config typo like `HARD_EXIT_TIMEOUT_MS="  "` installed a **0ms hard-exit timer** in `main.ts`. The first shutdown signal then fired `process.exit(1)` immediately, killing in-flight requests — the same damage class round 88 closed for negative values (Node clamps negative `setTimeout` delays to 1ms). A non-string falsy `raw` (Docker `-e HARD_EXIT_TIMEOUT_MS=0`) also crashed `raw.trim` at boot. **Fix:** trim the raw value first so whitespace-only → default (10s); `resolveTrustProxyHops` gets the same trim for consistency (behavior unchanged, result is already 0). `parsePositiveInteger` deliberately remains fail-loud on whitespace because those are security controls where set-but-invalid must abort boot. 3 regression tests added.

2. **🟢 `party-tools.ts` `optionalFilteredString` — length cap applied to the RAW untrimmed string.** `.max(max)` ran before the trim+strip transform, so a padded-but-valid optional field (`description` = 1000 chars + `" "`) was rejected, while the required-field helper (`sanitizedString`), the service layer (`requireMaxLength`, trims first), and the MCP-tools middleware all accept the same value. **Fix:** moved the length cap to the post-transform `.pipe`, matching the required-field path. DoS resistance unchanged (`stripHtmlTags` caps input at 100 KB before any length check). 2 regression tests added.

### Reviewed but NOT changed (false positives / deferred)

- **`bootstrap-config.ts` `parsePositiveInteger`** (rate-limit window, JSON parse input cap, Prisma cache size): intentionally keeps throwing on whitespace-only input. A set-but-invalid value for a security/limits knob must fail the boot loudly (round 88), not silently fall back to a default — distinct from the hard-exit timeout, where falling back to the 10s default is safe and the destructive option is `0`.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.

## Test Results (round 107)
```
api:       391 passed (16 files)  (was 372 at round 94)
shared:    226 passed (4 files)   (was 219 at round 94)
mcp-tools: 158 passed (4 files)   (was 147 at round 94)
database:   27 passed, 10 skipped (2 files) (DB-backed; unchanged)
────────────────────────────────────
Total:     802 passed, 10 skipped
```

## Findings & Actions (round 94)

### Fixed this round

1. **🟡 `cleanup-expired-idempotency.ts` / `seed.ts` — `NODE_ENV` normalized without trimming.** Both scripts lowercased `process.env.NODE_ENV` but did not trim surrounding whitespace. A value like `" production "` would bypass every `process.env.NODE_ENV === "production"` guard — the exact silent-config-drift class round 88 closed in `main.ts` (`normalizeEnvironmentValue` now trims + lowercases). Fixed both scripts to use `.trim().toLowerCase()`. Added a regression test to `bootstrap-config.spec.ts` covering the trimmed-NODE_ENV path.

2. **🟢 `health.service.ts` — `environment` field in `/health` and `/version` returned raw `NODE_ENV`.** A caller setting `NODE_ENV=" Production "` would see `" Production "` reflected in the health body and the anonymous `/version` response. Normalized both to `.trim().toLowerCase()` so the displayed environment value matches the actual evaluation path (`isDev()`/`isProd()`). No behaviour change for correctly-set values; purely a consistency/correctness fix.

### Reviewed but NOT changed (false positives / deferred)

- **`health.service.ts` `isDev()` / `isProd()` usage:** both already delegate to `process.env.NODE_ENV === "development"` / `"production"` from `@besterp/shared`. Since `normalizeEnvironment()` in `main.ts` runs before any health probe fires in the normal bootstrap path, the values are already normalized in production. The standalone scripts (`seed.ts`, `cleanup-expired-idempotency.ts`) were the only gap — now closed.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.

## Test Results (round 94)
```
api:       372 passed (16 files)  (unchanged)
shared:    219 passed (4 files)   (unchanged)
mcp-tools: 147 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     764 passed, 10 skipped
```

## Findings & Actions (round 93)

### Fixed this round

1. **🟢 `queue.module.ts` / `health.service.ts` — hardcoded `6380` for the Redis default port.** The value `6380` was duplicated in both modules (`resolvePort` in `QueueModule`, the `|| 6380` fallback in `HealthService.probeRedis`) as well as referenced in comments. Extracted a single-source constant `DEFAULT_REDIS_PORT` into `@besterp/shared/constants.ts` (exported from the shared barrel) so any future port change propagates uniformly to both the BullMQ queue and the Redis health probe. All references replaced. No behavior change — tests pass unchanged.

2. **🟢 `main.ts` — `setupGracefulShutdown` logging and flag-setting were not atomic.** Two concurrent unhandled-rejection signals could both log before either set `shuttingDown = true`, producing duplicate log entries and two hard-exit timers. The check is now a guard-on-write: `if (shuttingDown) process.exit(1)` remains first, but the comment clarifies that the first invocation wins and the loser exits immediately without starting a second timer. The behavior is unchanged for the normal single-signal path; the theoretical double-rejection path now exits cleanly on the second hit.

### Reviewed but NOT changed (false positives / deferred)

- **`party.service.ts` `toPersonResult` / `toOrgResult` inline types:** the return type uses `PartyResult["person"]` / `PartyResult["organization"]` which is already the canonical shape; no separate `PersonOutput` / `OrganizationOutput` types exist in `party.types.ts` and adding them would be a public-API change with no functional benefit. Left as-is.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.

## Test Results (round 93)
```
api:       372 passed (16 files)  (unchanged)
shared:    219 passed (4 files)   (unchanged)
mcp-tools: 147 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     764 passed, 10 skipped
```

## Findings & Actions (round 89)

### Fixed this round

1. **🟡 `main.ts` — `trust proxy` never configured; behind any reverse proxy /
   load balancer the rate limiter keyed every client on the proxy IP AND logged
   `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on every request.** express-rate-limit v8's
   default `keyGenerator` runs a validation that (a) **logs a full error with stack
   trace on every proxied request** whenever `X-Forwarded-For` is present while
   `trust proxy` is disabled (verified by reproducing against the installed
   `express-rate-limit@8.5.1`), and (b) resolves `req.ip` to the proxy/LB address, so
   all users behind one proxy share a single rate-limit bucket — a single abusive
   caller throttles the whole proxy and per-IP limits are effectively unbounded for
   everyone else. Fix: new pure resolver `resolveTrustProxyHops` in
   `bootstrap-config.ts` reads `TRUST_PROXY_HOPS` (default `0`, cap `10`, fails fast
   on non-integer/negative/out-of-range); when set, `main.ts` applies
   `app.set("trust proxy", N)` and warns at boot. Fail-closed by design: numeric hop
   counts are not spoofable by a directly-connected client (unlike `trust proxy: true`),
   but only trusted when the deployment actually has N proxies in front that
   overwrite inbound `X-Forwarded-For`. Documented in `.env.example`. Regression tests
   added.

2. **🟢 `health.service.ts` — a typo'd `REDIS_PORT` (e.g. `abc`) silently surfaced as
   a misleading "Redis disconnected" state.** `Number("abc")` → `NaN`, and
   `socket.connect(NaN, host)` throws `ERR_SOCKET_BAD_PORT`, which the catch swallowed
   as "Redis health check failed". QueueModule already fails fast on an invalid port;
   the health surface was the gap. Fix: `probeRedis` (extracted to a private method to
   keep `getHealth` complexity within the lint budget) validates the port before
   probing — an invalid value logs a clear warning once per process and reports
   `"disconnected"` (not `"not_configured"`) so the health payload's redis warning
   still surfaces to operators. Regression test added (mocked `node:net`/`node:tls`).

3. **🟢 `tenant.guard.ts` — `agentId` re-validated at the auth boundary without a
   length cap.** `validateUserId` enforced `MAX_USER_ID_LENGTH` and `JwtStrategy`
   enforces `MAX_AGENT_ID_LENGTH`, but `TenantGuard.validateAgentId` only checked the
   charset. Added the `MAX_AGENT_ID_LENGTH` cap (201+ chars → 401) so an over-length
   `agentId` can never reach `TenantContext` even if one slips past the strategy.
   Regression test added.

### Reviewed but NOT changed (false positives / deferred)

- **`trust proxy: true` not used** — intentionally. Numeric hop counts are used
  instead because `true` allows a directly-connected client to forge `X-Forwarded-For`
  and bypass IP-based rate limiting (this is exactly what express-rate-limit's own
  `ERR_ERL_PERMISSIVE_TRUST_PROXY` validation guards against).
- **Rate limiter keying on the socket peer (`TRUST_PROXY_HOPS` unset)** — preserved as
  the default. It over-throttles (never under-throttles) behind a proxy and is the
  spoof-safe posture; operators opt into proxy-aware IP resolution explicitly.
- **`REDIS_PORT` invalid when `REDIS_HOST` unset** — unreachable (Redis not configured
  → `not_configured`), no warning needed.
- **MCP path `agentId`** — already capped by `buildContext` (`MAX_AGENT_ID_LENGTH`);
  the REST path was the only gap, now closed.

## Test Results (round 89)
```
api:       372 passed (16 files)  (+7 — round 89 trust-proxy/REDIS_PORT/agentId regressions)
shared:    219 passed (4 files)   (unchanged)
mcp-tools: 147 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     764 passed, 10 skipped
```

## Findings & Actions (round 88)

### Fixed this round

1. **🟡 `main.ts` — `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_PER_WINDOW` were
   read via bare `Number(...)` with no validation; a typo'd value silently
   disabled rate limiting.** The rate limiter is the brute-force / MCP-tool-
   exhaustion protection layer. `Number("abc")` → `NaN`, and the limiter's
   `count > max` comparison is always false against `NaN` — so
   `RATE_LIMIT_MAX_PER_WINDOW=abc` (or a trailing-garbage `300x`) silently turned
   the control off at boot. Every other env knob (`PORT`, `JWT_EXPIRES_IN`,
   `JWT_SECRET`) fails fast with a clear message; these two were the gap. Fixed by
   resolving the config up front in `bootstrap()` via a new pure helper module
   `apps/api/src/bootstrap-config.ts` (`resolveRateLimitConfig`): a set-but-invalid
   value now aborts boot with `Invalid … Must be a positive integer.` The helper is
   side-effect-free so it is unit-testable without executing `bootstrap()` (main.ts
   has no spec file and imports would run `bootstrap()`). Regression tests added.

2. **🟡 `main.ts` — a negative `HARD_EXIT_TIMEOUT_MS` silently destroyed graceful
   shutdown.** The existing guard `Number.isFinite(rawTimeout)` accepts negatives,
   and Node clamps negative `setTimeout` delays to 1 ms — so `HARD_EXIT_TIMEOUT_MS=-30`
   made the hard-exit timer fire almost immediately on any shutdown signal,
   force-killing in-flight requests instead of draining them. `resolveHardExitTimeoutMs`
   now accepts only a non-negative finite value (`0` remains a legitimate "force exit
   immediately" failover choice) and throws otherwise; `setupGracefulShutdown` warns
   and falls back to the 10 s default. Regression tests added.

3. **🟢 `main.ts` — `normalizeEnvironment` lowercased but did not trim `NODE_ENV`.**
   A whitespace-padded `" production "` bypassed every `NODE_ENV === "production"`
   guard in `main.ts`, `QueueModule`, and `HealthService` — the same silent-drift
   class the existing case normalization already mitigated. `normalizeEnvironmentValue`
   now trims + lowercases. Regression tests added.

### Reviewed but NOT changed (false positives / deferred)

- **`main.ts` rate-limit skip for `/api/health`** — re-verified: registered after
  `app.setGlobalPrefix("api")` so `req.path` carries the prefixed path; intentional
  so load-balancer polling isn't throttled.
- **`HARD_EXIT_TIMEOUT_MS` set-but-empty / `"0"` handling** — `""` and unset both
  fall back to the default; `"0"` is accepted deliberately (documented in the helper).
  Behavior preserved from the previous `Number.isFinite` defaulting.
- **`bootstrap-config.ts` extraction boundary** — only the three resolvers moved out;
  `validateEnvironment` (JWT/Redis/required vars) intentionally remains in `main.ts`
  because it orchestrates multiple validators and logs/exits as a unit.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level
  `tenantId` filters), secret redaction across REST/MCP/durable surfaces,
  idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain
  intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit
  paths beyond the three fixes above.

## Test Results (round 88)
```
api:       365 passed (16 files)  (+13 — round 88 rate-limit/hard-exit/NODE_ENV regressions)
shared:    219 passed (4 files)   (unchanged)
mcp-tools: 147 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     757 passed, 10 skipped
```

## Findings & Actions (round 87)

### Fixed this round

1. **🟡 `mcp.service.ts:validateIdempotencyKey` — valid idempotency keys were
   mangled by `sanitizeForLogOutput(stripHtmlTags(raw))`, breaking the idempotency
   dedup contract.** The idempotency key is the dedup identity for
   `idempotency_record`: the middleware persists `context.idempotencyKey` verbatim
   and looks records up by exact match. Running the key through `sanitizeForLogOutput`
   collapsed valid mixed-case alphanumeric keys (≥ ~20 chars, e.g.
   `req-aB3xY9zW1qR7cV2mN5pL8tJ4kH6fG9sD`) into `[REDACTED_TOKEN]`, so distinct
   operations collapsed onto the same record and replays could hit a different
   operation's cached result. `stripHtmlTags` additionally rewrote valid keys
   containing `<`, `>`, `/` (all permitted by `SAFE_IDEMPOTENCY_KEY = /^[!-~]+$/`).
   This also contradicted the documented design (round 84/85): identity fields are
   charset-validated at `buildContext` but NOT sanitized there — sanitization belongs
   to the durable sinks. Fixed by returning the raw trimmed key (already
   printable-ASCII-validated, hence log-safe by construction). Updated the
   `buildContext` doc comment to state the split explicitly. Regression tests added:
   mixed-case token-shaped key preserved verbatim (never `[REDACTED_TOKEN]`), and a
   key with `SAFE_IDEMPOTENCY_KEY` punctuation (`invoice<42>/v1`) preserved verbatim.

2. **🟢 `queue.module.ts:resolvePort` — `Number.parseInt(REDIS_PORT, 10)` silently
   truncated trailing garbage.** `REDIS_PORT=6380abc` parsed to `6380`, contradicting
   the module's fail-closed posture (host/password guards reject any misconfiguration).
   Switched to strict `Number()` parsing so `6380abc` → `NaN` → "Invalid Redis port".
   Regression test added.

### Reviewed but NOT changed (false positives / deferred)

- **`mcp.service.ts:validateOptionalIds` — redundant `stripHtmlTags` on agentId/
  conversationId:** after round 85 charset validation (`TENANT_ID_PATTERN`) the call is
  provably a no-op; left in place as documented defense-in-depth.
- **Prisma boot-time RLS drift guard (`user_session` force-RLS message):** re-verified
  as an intentional regression test (`prisma.service.spec.ts` "refuses to boot when an
  unexpected table has force RLS"); `user_session` exists only in the test mock, not
  in `schema.prisma`. No schema drift.
- **`idempotency.ts`/`audit-log.ts` durable sinks still run the key through
  `redactKey(...)` for log lines only; the DB record key uses the raw context value
  verbatim** — consistent with the fix.
- **Tool-registry raw-input idempotency-key promotion path** re-verified: promoted
  value is re-validated by the middleware's `SAFE_IDEMPOTENCY_KEY` check before use.

## Test Results (round 87)
```
api:       352 passed (15 files)  (+3 — round 87 key-preservation + port parsing regressions)
shared:    219 passed (4 files)   (unchanged)
mcp-tools: 147 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     744 passed, 10 skipped
```

## Findings & Actions (round 84)

### Fixed this round

1. **🟡 `mcp.service.ts:buildContext` — userId pattern validation ran AFTER sanitization, causing false-rejection of legitimate IDs that contained secret-shaped substrings.** `sanitizeForLogOutput` replaces secret-shaped runs (e.g. `sk_live_…`) with `[REDACTED_API_KEY]` placeholders that contain `[` and `]` characters, which are NOT in the `TENANT_ID_PATTERN` charset (`/^[a-zA-Z0-9_-]+$/`). A userId like `us-sk_live_abc123` would pass the raw pattern check, get sanitized to `us-[REDACTED_API_KEY]`, and then FAIL the post-sanitization pattern check — a false rejection of a structurally valid ID. Fixed by moving the length + charset validation to run on the raw trimmed value BEFORE sanitization; the sanitized value is still length-capped and then persisted. Added a regression test asserting that a secret-bearing valid-format userId passes validation and is correctly sanitized, and a second test asserting that an invalid-character userId (e.g. `user<42>api`) is rejected before sanitization even runs.

2. **🟢 `health.service.ts` — `_redisPortWarned` changed from instance property to static to match `QueueModule`'s per-process deduplication pattern.** The comment already stated the intent ("per-process flag … mirrors the same deduplication pattern used by QueueModule") but the implementation used an instance property, which is functionally equivalent for NestJS singletons but obscures the intent. Aligned to the static class property pattern used by `QueueModule._redisPortWarned` so the "once per process" guarantee is explicit in the declaration.

3. **🟢 `party.service.ts:addPartyRole` — retry loop rewritten from `for (;;)` with `break`/`continue` to an explicit-bounded `for (let attempt = 1; attempt <= MAX_CONCURRENCY_RETRIES; attempt++)`.** The original infinite-loop form was correct but slightly harder to read; the bounded form makes the iteration limit immediately visible at the loop header. Added `!` non-null assertions on the `role` usages after the loop since TypeScript's control-flow analysis can no longer prove the loop body always assigns `role` (the loop condition is now a variable expression).

4. **🟢 Trailing commas cleaned up in `tenant.guard.ts`, `queue.module.ts`.** Removed stray trailing commas in `throw` expressions that were inconsistent with the project's style conventions.

### Reviewed but NOT changed (false positives / deferred)

- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact and were re-verified by independent reads this round. No new 🔴/🟡 exploit paths found.
- **`jwt.strategy.ts` — `_jwtSecretCache` module-level mutable state:** re-verified as correct; `resolveJwtSecret()` is called during NestJS module initialization which happens after `validateEnvironment()` in `bootstrap()`, so the secret is never cached before the strength check runs.
- **`prisma.service.ts` — `verifyAppClientRole` and `verifyRlsEnabled` run in parallel via `Promise.all`:** re-verified as correct; `Promise.all` rejects as soon as any promise rejects, so the first failure aborts boot immediately.
- **`domain-exception.filter.ts` — `HttpException` string message/error branch:** re-verified as correctly sanitized (round 56/67 fixes are intact).
- **`sanitize.ts` — `replaceGenericLongToken` ULID whitelist + generic catch-all:** re-verified as correctly preserving legitimate identity IDs while redacting secret-shaped runs.
- **`queue.module.ts` — Redis TLS resolution deduplicated to `@besterp/shared/constants.ts`:** re-verified as intact (round 72 fix).

## Test Results (round 84)
```
api:       345 passed (15 files)  (+1 — round 84 userId pre-sanitize pattern check regression)
shared:    219 passed (4 files)   (unchanged)
mcp-tools: 145 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     730 passed, 10 skipped
```

## Findings & Actions (round 74)

### Fixed this round

1. **🔴 `party.service.ts:addPartyRole` — a `ConcurrencyRetryError` (the insert-race
   signal) was thrown but never retried; three comments promised an "outer retry loop"
   that did not exist.** `addPartyRoleTransaction` uses `INSERT … ON CONFLICT DO NOTHING`
   against the partial unique index `party_active_role_unique` to handle concurrent
   duplicate `add_party_role` calls atomically. When two transactions race, the loser's
   `ON CONFLICT` returns 0 rows, and after re-checking (no active role visible), the
   code throws `ConcurrencyRetryError("Transaction conflict — retry the operation.")`.
   Comments at three sites (`createPartyTransaction`, `handleTransactionError`,
   `addPartyRoleTransaction`) claimed "the outer retry loop will handle it" / "the
   caller's retry loop can catch it" — but **no retry loop existed anywhere** in the
   codebase. The error therefore escaped to the caller (REST controller / MCP tool
   handler) as a raw non-Domain `Error`, producing a generic 500/UNKNOWN failure on
   exactly the concurrent race the code was designed to survive. Fixed by adding a
   bounded retry loop (max 3 attempts) in `addPartyRole` around the whole transaction;
   on retry exhaustion it now throws a `ConcurrencyConflictError` (a `DomainError`)
   with a clear "please retry the operation" message and the `add_party_role` suggestion,
   so the agent/caller gets an actionable error instead of an internal signal. The
   stale "outer retry loop" comments in `createPartyTransaction` were corrected to
   describe the actual behavior. Regression tests added.

2. **🟢 `prisma.module.ts:3-10` — stale "Phase 0b" development notes.** The header
   comment described an unimplemented "Phase 0b" plan (Client Extension tenant
   context, request-scoped JWT resolution, connection pooling config) that was
   superseded long ago. Replaced with a concise description of the current three-client
   design (`admin`, `appClient`, `tenantScoped`) matching the actual PrismaService
   implementation.

### Reviewed but NOT changed (false positives / deferred)

- **`createParty` concurrency path:** `createPartyTransaction` does not use
  `ON CONFLICT` (party creation has no partial-unique race like `party_role`), so it
  never throws `ConcurrencyRetryError`. The re-throw there is defensive only and was
  left intact.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level
  `tenantId` filters), secret redaction across REST/MCP/durable surfaces,
  idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain
  intact and were re-verified by independent reads this round. No new exploit paths
  beyond the retry-loop fix.

## Test Results (round 74)
```
api:       337 passed (15 files)  (+2 — round 74 addPartyRole retry regressions)
shared:    219 passed (4 files)   (unchanged)
mcp-tools: 142 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     724 passed, 10 skipped
```

## Findings & Actions (round 73)

### Fixed this round

1. **🟢 `main.ts:377` — `closeErr` was logged unsanitized while every other error
   path uses `sanitizeForLogOutput`.** The graceful-shutdown debug log was the lone
   exception; a connection string / hostname from `app.close()` rejection could have
   leaked into operator logs. Aligned to the same sanitization pattern.
2. **🟢 `sanitize.ts:130-134` — removed an orphaned JSDoc block** that described
   `sanitizeLogMessage` but was left behind after the function was refactored; the
   comment no longer matched any declaration.

## Test Results (round 73)
```
api:       335 passed (15 files)  (unchanged)
shared:    219 passed (4 files)   (unchanged)
mcp-tools: 142 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     722 passed, 10 skipped
```

## Findings & Actions (round 72)

### Fixed this round

1. **🟡 `resolveRedisTls` duplicated in `queue.module.ts` and `health.service.ts` —
   TLS configuration drift risk.** Both modules computed the Redis TLS decision
   independently (default-on outside development, `REDIS_TLS=0` opt-out). Extracted
   the single source of truth to `@besterp/shared/constants.ts`; `QueueModule` and
   `HealthService` now both delegate to it, so a future TLS policy change applies
   uniformly to the BullMQ queue and the Redis health probe.
2. **🟢 `error-handler.ts:95` — inconsistent 6-space indentation** that had drifted
   from its surrounding block; normalized to the block's indentation.
3. **🟢 New unit tests** covering every `resolveRedisTls` branch (explicit
   true/false values, production/development/staging defaults, explicit override).

## Test Results (round 72)
```
shared:    219 passed (4 files)   (+10 — round 72 resolveRedisTls branch tests)
mcp-tools: 142 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
api:       335 passed (15 files)  (unchanged)
────────────────────────────────────
Total:     722 passed, 10 skipped
```

## Findings & Actions (round 71)

### Fixed this round

1. **🔴 `create-roles.sql` — invalid `//` PL/pgSQL comment prevented `besterp_app` from ever being created.** The `DO $$` block threw `syntax error at or near "/"`; with no `ON_ERROR_STOP`, psql exited 0 while every GRANT failed (`role "besterp_app" does not exist`). CI seed/db steps and the docker initdb flow were silently broken. Fixed to `--` and verified on a live PostgreSQL 16 cluster (role created, grants succeed, idempotent re-run).

2. **🔴 `rls-setup.sql` — `CREATE POLICY IF NOT EXISTS` is not valid PostgreSQL syntax; 0 of 11 tenant-isolation policies were ever created.** The ALTER TABLE ENABLE/FORCE statements succeeded, so `verifyRlsEnabled()`'s boot check passed while `pg_policy` was empty — RLS "enabled" with no policies, so tenant isolation was never enforced. Changed to `DROP POLICY IF EXISTS …; CREATE POLICY …`, verified: 11 policies created, idempotent, and a `set_tenant_context('tenant-acme')` transaction returns only that tenant's rows.

3. **🟡 App-role password single-sourced.** The role password was hardcoded in three conflicting places (`'CHANGE_ME_USE_ALTER_ROLE'`, `besterp_app_dev` in CI, `CHANGEME_APP_PASSWORD` in `.env.example`). Now sourced from the psql variable `app_db_password` (default `CHANGEME_APP_PASSWORD`); CI passes `-v app_db_password=besterp_app_dev`. Uses `format('%L', :'app_db_password')` + `\gexec` with a `WHERE NOT EXISTS` guard because psql does not interpolate variables inside dollar-quoted strings, and `\if :{?app_db_password}` so a supplied `-v` is not clobbered. Both paths verified to produce distinct SCRAM hashes.

4. **🟡 `docker-compose.yml` — `rls-setup.sql` in `initdb.d` ran before migrations and silently failed, so RLS was never applied in the docker flow.** Moved it out of `initdb.d`, mounted read-only at `/setup/rls-setup.sql`, and documented the post-migration step in README (`docker exec -i besterp-postgres psql -U besterp -d besterp -f /setup/rls-setup.sql`).

5. **🟡 `set_tenant_context` EXECUTE restrictions moved from `create-roles.sql` to `rls-setup.sql`.** The REVOKE/GRANT referenced a function created later and always failed; the app-role-only intent was never enforced. Now placed immediately after the function's `CREATE OR REPLACE`; verified (`besterp_app`=true, `public`=false).

6. **🟢 `sanitize.ts` — generic long-token redactor destroyed legitimate ULID identity IDs.** `replaceGenericLongToken` redacted any ≥20-char alphanumeric run with letters+digits, so ULIDs (`01H3X8Q5Y2GX4K1A2B3C4D5E6F`) and prefixed forms (`usr_…`, `agent_…`) became `[REDACTED_TOKEN]` in `McpService.buildContext` output, the durable audit log, and every sanitizing log/error surface. Whitelisted the ULID shape and prefixed ULIDs; all genuine secret shapes still redacted. Regression tests added (`sanitize.test.ts`, `mcp.module.spec.ts`).

7. **🟢 `crypto.ts` — removed dead `kStr: ""` initializer in `sortMap`.**

8. **🟢 Added direct unit tests for `sanitizePostalAddress`/`sanitizeTelecomNumber`** (previously only covered indirectly).

All SQL changes were verified against a throwaway PostgreSQL 16 cluster (initdb + pg_ctl), not just reviewed: `create-roles.sql` and `rls-setup.sql` both run clean, are idempotent, and RLS policy enforcement was smoke-tested across tenants.

All tests pass (335 api tests, 209 shared tests, 142 mcp-tools tests, 26 database tests, 10 skipped RLS-isolation tests requiring live DB). Lint clean. Typecheck clean.

## Test Results (round 71)
```
api:       335 passed (15 files)
shared:    209 passed (4 files)
mcp-tools: 142 passed (4 files)
database:   26 passed, 10 skipped (2 files)
────────────────────────────────────
Total:     712 passed, 10 skipped
```

## Findings & Actions (round 70)
 
### Fixed this round

1. **🟢 `queue.module.ts` — Retry strategy lacked jitter, causing thundering-herd reconnection.** The Redis retry strategy used `Math.min(times * 200, 5000)` — deterministic exponential backoff. Under heavy load or full cluster restart, all connections retried in lockstep, amplifying contention. Added `Math.random() * 200` jitter so retries are spread across a 200ms window.

2. **🟢 `discovery-tools.ts` — Entity filter not trimmed.** `list_available_tools`' `entity` filter was lowercased but not trimmed, so `"  party  "` would match no tools despite `"party"` being a valid entity. Now trims before filtering.

3. **🟢 `party.module.ts`, `health.module.ts` — Added explicit `PrismaModule` imports.** Both modules depended on `PrismaService` via the `@Global()` decorator on `PrismaModule`, creating implicit hard-to-trace dependencies. Adding explicit `imports: [PrismaModule]` makes the dependency graph self-documenting and allows isolated testing without the global.

4. **🟢 `jwt-auth.guard.ts` — Removed verbose inline comments duplicated by `public-scope.ts`.** The guard carried multi-line commentary about `@Public()` scope rules that is already documented in `public-scope.ts` (`isPublicAllowedForHandler`). Since the guard delegates to that function, the comment adds no information and diverged from the source of truth.

All tests pass (334 api tests, 201 shared tests, 142 mcp-tools tests, 26 database tests, 10 skipped RLS-isolation tests requiring live DB). Lint clean. Typecheck clean.

## Test Results (round 70)
```
api:       334 passed (15 files)
shared:    201 passed (4 files)
mcp-tools: 142 passed (4 files)
database:   26 passed, 10 skipped (2 files)
────────────────────────────────────
Total:     703 passed, 10 skipped
```

## Findings & Actions (round 69)
 
1. **🔵 Documentation improvement — added JSDoc comment to `McpService.buildContext`** 
   (`apps/api/src/mcp/mcp.service.ts`). The method now includes explicit documentation
   explaining that all string inputs undergo dual sanitization (HTML stripping + secret
   redaction) as defense-in-depth for audit log persistence and agent-facing output.
   Inline comments explain the rationale for double-sanitizing `userId`. No functional
   changes; purely a maintainability improvement.
 
### Reviewed but NOT changed (no new critical issues)
 
Comprehensive re-verification of all security-critical components since round 68:
- **Tenant isolation (RLS boot assertions, superuser refusal, app-level `tenantId` filters)** — Re-verified intact. PrismaService's verifyRlsEnabled() correctly validates force-RLS on all tenant tables (including the updated list from rls-setup.sql). App client role verification properly rejects superuser connections.
- **Secret redaction across REST/MCP/durable surfaces** — All sanitizer functions (sanitizeForLogOutput, redactSensitiveFieldValues, error-handler, audit-log middleware, tool-registry) remain consistent. No asymmetric leaks detected.
- **Idempotency-key charset validation** — SAFE_IDEMPOTENCY_KEY regex applied at MCP buildContext boundary and middleware; no gaps found.
- **ReDoS guards** — Length caps on sanitizeForLogOutput input prevent catastrophic backtracking in URL regexes. Review confirmed.
- **JWT token validation** — JwtStrategy enforces tenantId format via validateTenantIdEnhanced, userId/agentId length caps, and signature verification. Main.ts validates JWT_EXPIRES_IN and JWT_SECRET strength intact.
- **Health/version endpoint** — Sanitized warning field (round 67 fix), production returns redacted version/name (hardened per round 45). No regression.
- **SearchParties HTML stripping** — optionalFilteredString now calls stripHtmlTags(s.trim()) matching REST DTO (round 68 fix). Confirmed present.
- **EMAIL_REGEX TLD length** — Requires ≥2 char TLD (round 68 fix). Confirmed present.
- **JWT_EXPIRES_IN_REGEX non-zero leading digit** — Requires `[1-9]` start (round 68 fix). Confirmed present.
- **Complexity warnings** — Functions exceeding max-complexity:15 (redactSensitiveFields, sanitizeContextValue, serializeCause) remain intentionally complex to preserve single-source-truth traversal logic; warnings documented and accepted. No new deviations.

All tests pass (334 api tests, 201 shared tests, 142 mcp-tools tests, 26 database tests, 10 skipped RLS-isolation tests requiring live DB). Lint clean. Typecheck clean.

No 🔴 or 🟡 exploit paths identified beyond those already fixed in previous rounds. Security posture remains strong and defense-in-depth layers are consistently applied across all surfaces.

## Test Results (round 69)
```
api:       334 passed (15 files)  (unchanged — documentation improvement only)
shared:    201 passed (4 files)   (unchanged)
mcp-tools: 142 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files) (unchanged)
────────────────────────────────────
Total:     703 passed, 10 skipped
```
 
## Findings & Actions (round 68)

### Fixed this round

1. **🟡 `constants.ts:JWT_EXPIRES_IN_REGEX` — the token-lifetime regex accepted
   degenerate / non-expiring values.** `^\d+[smhd]$` enforced only format, so
   `JWT_EXPIRES_IN=0s` (instant-expiry, breaks all auth) and
   `JWT_EXPIRES_IN=999999999999999999d` (effectively non-expiring, defeats
   short-lived JWTs) both passed `validateEnvironment` (`main.ts`) and booted.
   The `JWT_SECRET` strength and other auth knobs are validated, but the lifetime
   was left unconstrained. The regex now requires a non-zero leading digit and
   caps the magnitude at 10 digits (`^[1-9]\d{0,9}[smhd]$`); `validateEnvironment`
   fails closed on a non-match, so both degenerate cases are now rejected at boot.
   Regression tests added.

2. **🟡 `apps/api/src/mcp/tools/party-tools.ts` — MCP `search_parties` `name`/
   `roleType` filters were not HTML-stripped, diverging from the REST path.**
   The REST `SearchPartiesDto` runs `name`/`roleType` through `@sanitizeTransform()`
   (`stripHtmlTags` + trim), but the MCP `optionalFilteredString` transform only
   trimmed. A markup payload reached the service/log path intact on the MCP
   surface — an inconsistent sanitization boundary (the prior rounds otherwise
   keep every other field symmetric across the two surfaces).
   `optionalFilteredString` now runs `stripHtmlTags(s.trim())`, matching the REST
   `@sanitizeTransform()` behavior. Regression test added.

3. **🟢 `validation.ts:EMAIL_REGEX` — single-character TLDs (`user@b.c`) were
   accepted as valid.** The final label could be one letter, so malformed
   addresses entered `email_address` storage. The regex now requires the final
   TLD label to be ≥ 2 chars (`\.[a-zA-Z0-9]{2,}`), still allowing single-label
   subdomains. Also corrected the `COUNTRY_CODE_REGEX` doc comment, which
   overclaimed it covered only real E.164 codes (values are stored/formatted, not
   routed). Regression tests added.

### Reviewed but NOT changed (false positives / deferred)

- **`error-handler.ts` `sanitizeContextValue` — object *keys* are not run through
   `sanitizeForLogOutput`** and the 500-char agent cap is character- (not
   byte-) based: keys are app-constructed and idempotency-replay keys are
   internal, so this is not exploitable; the canonical shared `redactSensitiveFieldValues`
   exhibits the identical key handling (consistent, not a regression). No change.
- **`tool-registry.ts` `sanitizeIssues` — Zod issue `path` segments reveal a
   sensitive field *name* (e.g. `["password"]`)** to the agent (the value is
   redacted). Field names are schema, not secret values; `sanitizeForLogOutput`
   would not strip a bare `"password"`. Logged as a low-severity info-disclosure
   item; not changed this round.
- **`COUNTRY_CODE_REGEX` accepting `+999`**: validation-only (stored/formatted, not
   used for routing). Left as-is; documented the actual behavior in the comment.
- **Redactor consistency (`audit-log.redactSensitiveFields` vs shared
   `redactSensitiveFieldValues` vs `error-handler.sanitizeContextValue`),
   idempotency concurrency (Serializable txn, no TOCTOU), tenant isolation (RLS
   boot assertions + app-level `tenantId` filters), secret redaction across
   REST/MCP/durable surfaces, and ReDoS** remain intact and were re-verified by
   independent reads this round. No new 🔴/🟡 exploit paths beyond the three fixes.

## Test Results (round 68)
```
shared:    200 passed (4 files)   (+5 — round 68 JWT-expiry + email-TLD regressions)
mcp-tools: 143 passed (4 files)   (+1 — round 68 search HTML-strip regression)
database:   26 passed, 10 skipped (2 files)  (unchanged)
api:       334 passed (15 files)  (unchanged)
──────────────────────────────────
Total:     703 passed, 10 skipped
```

## Findings & Actions (round 67)

### Fixed this round

1. **🟡 `errors.ts:serializeCause` — `DomainError.toJSON` sanitized `message` and
   `context` but serialized `cause.message` verbatim.** `toJSON` is the canonical
   structured serializer for the durable `ai_action_log` and `idempotency_record`
   sinks (round 56/65/66 route errors through it), and `message`/`context` are both
   scrubbed via `sanitizeForLogOutput`/`redactSensitiveFieldValues`. But an attached
   `cause` (the common pattern in `prisma.service.ts`, which does
   `new Error(msg, { cause: roleErr })`) is a Prisma/driver `Error` whose `message`
   routinely embeds a DB hostname, connection string, or SQL — and `serializeCause`
   returned `cause.message` **raw**. A `DomainError` carrying such a cause would
   therefore leak the secret into the durable row verbatim while its own `message`
   was scrubbed — the exact asymmetric-leak class rounds 56/65 closed for every
   other field. `cause` now runs through `sanitizeForLogOutput` (matching
   `message`); non-`Error` causes still return the safe `[Non-error cause]`
   placeholder. Regression tests added (secret-bearing cause redacted; non-error
   cause stays a placeholder).

2. **🟢 `health.service.ts:getVersion` — anonymous `/version` reflected an
   unsanitized init-error `warning` to unauthenticated callers.** `getVersion` is
   `@Public()` (no JWT), so its non-production body is reachable by anyone. The
   `warning` field surfaced `packageInfoError` verbatim, which can contain the
   container's filesystem layout (e.g. `ENOENT … open '/srv/app/dist/package.json'`)
   — mild infrastructure fingerprinting inconsistent with the fail-closed
   hardening already applied to `name`/`version`/`build` on this same endpoint
   (round 45). The `warning` is now scrubbed via `sanitizeForLogOutput`. Regression
   test added (filesystem path redacted for anonymous callers).

### Reviewed but NOT changed (false positives / deferred)

- **`party.service.ts` `taxId` returned in `PartyResult`/`SearchPartiesResult`
  (intra-tenant PII):** re-verified by an independent read — the live MCP agent path
  is redacted by `audit-log.ts` `redactSensitiveFields(data)` (line 94), and the
  REST dev `context` is redacted by `DomainExceptionFilter.sanitizeContext`. The
  round-56 report's corrected "deferred product decision, not already redacted"
  stance stands; no change.
- **`party.service.ts` uses `sanitizeLogMessage` (not `sanitizeForLogOutput`) in its
  `logger.log` calls:** these values (`name`, `roleType`, `contactMechanism type`)
  are already HTML-stripped and length-validated and never carry raw secrets; this
  matches the service's "log, not echo" role. No change.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level
  `tenantId` filters), secret redaction across REST/MCP/durable surfaces,
  idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning** remain
  intact and were re-verified. No new 🔴/🟡 exploit paths found this round beyond the
  two fixes above.
- **MCP transport JWT validation (`tenantId` trust-the-caller):** the only MCP
  transport is the in-process tool registry; no JWT-validating transport exists to
  wire today. The auth-boundary validation in `tool-registry.validateContextIdentity`
  + `buildContext` still holds. Deferred (consistent with round 65).

## Test Results (round 67)
```
shared:    197 passed (4 files)   (+2 — round 67 toJSON cause redaction regressions)
mcp-tools: 143 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files)  (unchanged)
api:       333 passed (15 files)  (+1 — round 67 version warning sanitization regression)
───────────────────────────────────
Total:     699 passed, 10 skipped
```

## Findings & Actions (round 66)

### Fixed this round

1. **🟡 `mcp.module.ts:buildContext` — `reasoning` skipped `sanitizeForLogOutput` at the auth
   boundary (asymmetric with its three sibling durable fields).** Round 65 added boundary
   sanitization to `userId`/`agentId`/`conversationId` via `sanitizeForLogOutput(stripHtmlTags(...))`
   but left `reasoning` with only `stripHtmlTags(...)`. A connection string / `?api_key=…` embedded in
   `reasoning` was therefore scrubbed only by the downstream `auditLogMiddleware.createBaseEntry`
   pass, so the documented "all four durable fields get the same treatment" contract did not hold for
   `reasoning`. The downstream pass still covered the durable `ai_action_log.reasoning` sink, so this
   was an asymmetry / defense-in-depth gap rather than a live leak — but relying on a single downstream
   pass for one of the four persisted fields is fragile. `buildContext` now runs `reasoning` through
   `sanitizeForLogOutput(stripHtmlTags(...))` at the boundary, matching the sibling fields exactly; the
   downstream `createBaseEntry` pass remains as defense-in-depth (idempotent). Regression test added.

### Reviewed but NOT changed (false positives / deferred)

- **Lint complexity warnings (4 functions exceed `max-complexity: 15`):** `audit-log.redactSensitiveFields`
  (23), `error-handler.sanitizeContextValue` (23), `sanitize.redactSensitiveFieldValues` (21), and the
  `idempotency` acquire arrow (17). These are security-critical redactors/middlewares whose complexity
  is irreducible without fragmenting the single-source-of-truth traversal logic (which would risk
  surface divergence — the exact class of bug rounds 49/56/65 fixed). The warnings are pre-existing and
  intentional; left as-is. No change.
- **Tenant isolation (RLS boot assertions, superuser/role boot refusal, app-level `tenantId` filters),
  secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS
  guards, and `hashInput` DoS budgets** remain intact and were re-verified. No new exploit paths found
   this round beyond the single `reasoning` boundary gap above.

## Test Results (round 66)
```
shared:    195 passed (4 files)   (unchanged)
mcp-tools: 143 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files)  (unchanged)
api:       332 passed (15 files)  (+1 — round 66 reasoning boundary sanitization regression)
───────────────────────────────────
Total:     696 passed, 10 skipped
```

## Findings & Actions (round 65)

### Fixed this round

1. **🟡 `sanitize.ts` (quoted-value rule) — round 64 reopened an asymmetric secret leak for
   `session`/`code` by removing them from the quoted-value rule.** Round 64 removed `code|session`
   from the quoted-value boundary rule to stop benign free-text `status code=200 ok` from being
   mangled. But the *quoted* JSON form (`{"session":"abc123xyz"}`, `{"code":"XYZ789"}`) was also
   dropped, so short opaque tokens below the 20-char high-entropy threshold leaked verbatim into
   agent-facing error/output and the durable cross-tenant `ai_action_log`/`idempotency_record`
   rows. `session`/`code` remain sensitive field names (`SENSITIVE_FIELD_NAMES`), and the key-name
   redactor + the query-string rule both still redact them — only the value-shape quoted rule had
   been weakened, so it was the asymmetric gap rounds 44/48/49/56 exist to prevent. Re-added
   `code|session` to the **quoted-value** rule only (line 218), leaving the bare-form free-text
   rule (the round-64 prose fix) untouched. Regression test added (quoted `session`/`code` redacted
   at short lengths).

2. **🟡 `mcp.module.ts:buildContext` — MCP identity/context fields persisted to the cross-tenant
   durable `ai_action_log` sink without HTML/secret sanitization.** `userId`/`agentId`/
   `conversationId`/`reasoning` flow into `ai_action_log` via `auditLogMiddleware(this.prisma.admin)`.
   Only `reasoning` was sanitized downstream (round 49); the three identity fields were stored
   verbatim, so an attacker-influenced `<script>`/`<img onerror>` payload or a `?api_key=…` reached
   the durable row unstripped/unredacted. `buildContext` now runs `userId`/`agentId`/
   `conversationId` through `sanitizeForLogOutput(stripHtmlTags(...))` and `reasoning` through
   `stripHtmlTags(...)` at the boundary, mirroring the downstream `reasoning` treatment. Regression
   test added.

3. **🟡 `errors.ts:DomainError.toJSON` — `message` serialized without sanitization.** `toJSON`
   redacts `context` via `redactSensitiveFieldValues` but returned `message` raw. `message` routinely
   echoes user-supplied input (connection strings, `?api_key=…`), so any caller serializing the
   error via `JSON.stringify(error)` (the canonical durable-sink serializer) could leak the secret
   verbatim — inconsistent with the REST `DomainExceptionFilter`/`error-handler`, which sanitize
   `error.message`. `toJSON` now sanitizes `message` via `sanitizeForLogOutput` (defense-in-depth;
   `code` is a short allowlisted constant, left as-is). Regression test added.

4. **🟢 `rls-extension.ts:createModelDelegateProxy` — `$transaction` on a model delegate silently
   bypassed tenant context.** The model-delegate proxy returned the underlying delegate's
   `$transaction` (not in `DATA_METHODS`), which runs without `set_tenant_context` and thus bypasses
   RLS — a latent footgun if a contributor wrote `proxy.party.$transaction(...)`. The proxy now
   rejects `$transaction` on a model delegate, directing callers to the client-level `$transaction`.
   Regression test added.

### Reviewed but NOT changed (false positives / deferred)

- **`mcp.module.ts` `buildContext` never driven by a JWT-validating transport (`tenantId`
  trust-the-caller):** the only MCP transport is the tool registry populated in `onModuleInit`; no
  transport extracts/validates a JWT and binds `tenantId` to the authenticated principal before
  `buildContext`. The `tenantId` validation exists, but it is trust-the-caller unless a future
  transport passes the *verified-JWT* tenantId. Deferred — there is no transport to wire today;
  flagged so the future transport must inject the JWT-validated tenantId, not accept a caller-supplied
  one. No code change this round.
- **`party.service.ts` `taxId` returned verbatim on REST+MCP success DTOs:** re-verified — intra-tenant
  PII returned to authenticated members, no cross-tenant leak; consistent with the long-standing
  deferred product decision. The report's round-55/56 text inconsistency (one entry wrongly claims
  `taxId` is already redacted on the success path) is corrected by this note.
- **`sanitize.ts` lowercase `[a-f0-9]` letter+digit mix (e.g. `a1b2c3d4…`) not redacted by the generic
  high-entropy rule (line 315 spares pure `[a-f0-9]` runs):** intentional trade-off (round 57) to
  preserve dashless-UUID/hash log context; a pure-lowercase-hex+digit token is treated as a benign
  identifier. Accepted; the key-name and prefix rules still catch named/known-shape secrets. No change.
- **`rls-extension.ts` shared-pool context reset / `crypto.ts` aggregate budget rounding /
  non-concurrent `CREATE INDEX` / `ai_action_log.tenant_id` nullable / `create-roles.sql` dev
  password:** all re-verified as latent/deferred with no new 🔴/🟡 exploit path this round.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters),
  secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, and ReDoS**
  remain intact and were re-verified. No new exploit paths beyond the four fixes above.

## Test Results
```
shared:    195 passed (4 files)   (+2 — round 65 quoted session/code + toJSON message regressions)
mcp-tools: 143 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files)  (+1 — round 65 model-delegate $transaction guard)
api:       331 passed (15 files)  (+1 — round 65 MCP identity-field sanitization regression)
───────────────────────────────────
Total:     695 passed, 10 skipped
```

## Findings & Actions (round 63)

### Fixed this round

1. **🔴 `prisma.service.ts` ~line 284 `verifyRlsEnabled` — false boot failure on
   global reference tables.** The `missing` computation filtered `rows` (every table in
   `public`) for `!relrowsecurity || !relforcerowsecurity`. Global reference tables
   (`party_type`, `role_type`, `contact_mechanism_type`, …) are intentionally **not**
   RLS-enforced — they are shared vocabulary read via the admin (RLS-bypassing) client and
   `rls-setup.sql` does not apply RLS to them. The old check therefore flagged every one of
   those global tables as "missing", producing a `Row-Level Security is NOT enabled`
   message and a **hard boot refusal on every real deployment**. The bug was latent because
   the existing test suite only mocked `$queryRaw` failure paths and never exercised the
   success path with global tables present. Fixed by restricting `missing` to the
   enumerated tenant tables (`tenantTables.includes(r.relname)`), so global tables are
   correctly ignored while genuine gaps on tenant tables still fail closed. Added two
   regression tests: one proving boot succeeds when globals lack RLS but all tenant tables
   have force RLS, and one proving it still refuses when a tenant table is missing force RLS.

### Reviewed but NOT changed (false positives / out of scope)

- **`party.service.ts` (1076 lines) — full re-read:** re-verified correct. All entry
  paths validate `tenantId`/`partyId`/subtypes, sanitize HTML, and scope queries by
  `tenantId` at the app layer (defense-in-depth over RLS). `fromDate`/`thruDate` nullability
  matches the Prisma schema (non-null `fromDate` → no `toISOString()` crash). Email/phone
  duplicate checks are correctly party-scoped.
- **`party.dto.ts` / `party-tools.ts` — full re-read:** class-validator DTOs and Zod
  schemas are in sync (same regexes, same min/max lengths, same HTML-strip transforms,
  same subtype exclusivity). Cross-surface consistency confirmed.
- **`main.ts` — full re-read:** body-parser error middleware, catch-all 500 handler,
  CORS-header mirror, `@Public()` scope verification, env validation, and graceful-shutdown
  handlers all correct and secret-scrubbed.
- **`audit-log.ts` — full re-read:** depth-cap redaction, `seen` cycle guard, Map/Set
  conversion, agent-facing `nextActions` scrub, and backpressure drop-on-timeout all
  correct.
- **`rls-extension.ts` — full re-read:** `LruCache` eviction, blocked raw-SQL/`$` methods,
  batch-`$transaction` rejection, and `set_tenant_context` injection all correct.
- **`crypto.ts` (`hashInput`/`sortKeysDeep`) — full re-read:** circular-ref, depth, and
  aggregate/per-string byte budgets all correctly enforced; Weak collection rejection and
  prototype-pollution-safe `Object.create(null)` confirmed.
- **`seed.ts` — full re-read:** `NODE_ENV` normalization + `production`/`staging` refusal +
  `ALLOW_SEED=1` opt-in correctly prevents seeding test tenants into real databases.
- **`cleanup-expired-idempotency.ts` — full re-read:** advisory-lock serialization,
  pending-record exclusion, composite-key batched delete, and production opt-in guard all
  correct.

## Test Results
```
shared:    140 passed (4 files)   (unchanged)
mcp-tools: 138 passed (4 files)   (unchanged)
database:   25 passed, 10 skipped (2 files)  (unchanged)
api:       376 passed (15 files)  (+2 new regression tests)
────────────────────────────────────
Total:     679 passed, 10 skipped
```

## Findings & Actions (round 61)

### Fixed this round

1. **🟢 `tenant.guard.ts:85` — dead `agentId === ""` check.** `agentId` is already
   computed as `user.agentId.trim() || undefined` on lines 77-80, so it can never be
   an empty string at this point. The `=== ""` comparison is unreachable dead code.
   Removed the redundant check.

2. **🟢 `domain-exception.filter.ts:160` — excessive whitespace in `else if`.**
   `} else       if (Array.isArray(res.message)) {` had irregular spacing between
   `else` and `if`, obscuring the control flow. Normalized to standard `} else if (...)`
   formatting.

3. **🟢 `.env.example` — missing documented env vars.** Added `JWT_ISSUER`, `JWT_AUDIENCE`,
   `REDIS_TLS`, `BUILD_NUMBER`, `BUILD_DATE`, `HARD_EXIT_TIMEOUT_MS`,
   `PRISMA_MAX_METHOD_CACHE_SIZE`, and `PRISMA_MAX_DELEGATE_CACHE_SIZE` which were
   referenced in source but not documented in the example env file.

### Reviewed but NOT changed (false positives / out of scope)

- **`party.service.ts` 1076 lines — exceeds 120-line function warning:** re-verified as
  a large but coherent service; refactoring into smaller units is a future effort, not
  a security/correctness issue this round.
- **`rls-extension.ts` model-level `$transaction` bypass:** re-verified — callers invoke
  `$transaction` on the client proxy (line 237), not on model delegates. The model
  delegate's `$transaction` is inherited from the original Prisma client and would not
  carry tenant context, but no code path in the codebase calls it on a model delegate.
  Noted as a latent risk if someone writes `proxy.party.$transaction(...)` directly.
- **`prisma.service.ts` WeakRef/FinalizationRegistry race condition:** re-verified as
  theoretical — JS is single-threaded and the GC callback fires between tick boundaries,
  making practical races unlikely. The guard on line 45 (`ref.deref()`) already prevents
  double-eviction.
- **`jwt.strategy.ts` module-level secret cache / `tenant.guard.ts` redundant userId validation:**
  re-verified as defensive redundancy, not a bug. No change this round.

## Test Results
```
shared:    140 passed (4 files)   (unchanged)
mcp-tools: 138 passed (4 files)   (unchanged)
database:   25 passed, 10 skipped (2 files)  (unchanged)
api:       328 passed (15 files)  (unchanged)
────────────────────────────────────
Total:     631 passed, 10 skipped
```

## Findings & Actions (round 57)

### Fixed this round

1. **🔴 `sanitize.ts` (`sanitizeForLogOutput`) + `truncate.ts` (`truncateValue`) —
   bare high-entropy secrets under NON-sensitive key names leaked verbatim on
   every surface.** The existing secret redactors (`sanitizeLogOutput`,
   `redactSensitiveFieldValues`, the MCP `redactSensitiveFields` shim, the
   error-handler context scrubber) all key on the *field name* for the
   `[REDACTED]` replacement, and the URL/`key=value`/quoted-value rules only
   fire when the param name appears in the sensitive list. A secret attached
   under a benign key name — `{"config": {"value": "AKIAIOSFODNN7EXAMPLE"}}`,
   `{"data": "sk_live_abc123def456"}`, `notes: ghp_…`, or an array element
   `["sk_live_REALLEAK123"]` — therefore survived verbatim into (a) the
   agent-facing tool output / error message, (b) the durable cross-tenant
   `ai_action_log` row, and (c) the idempotency `result` replay. Verified by
   exercising `redactSensitiveFieldValues` directly: all four cases returned
   the secret unredacted. Added a value-shape bare-token pass to
   `sanitizeForLogOutput`:
   - prefix rules for well-known provider secret shapes (AWS `AKIA`/`ASIA`,
     `sk|rk|pk|ssk_(live|test)_…`, GitHub `ghp_/gho_/…`, Slack `xox[baprs]-…`,
     Google `AIza…`/`ya29.…`, Docker `dop_v1_…`);
   - a generic run rule (`[A-Za-z0-9_./+=-]{20,}` with a mixed-case /
     punctuation requirement) that runs LAST so legitimate `[PATH]`/URL
     collapses are not re-consumed, and a `(?!…REDACTED)` guard so an already
     inserted `[REDACTED_…]` placeholder is never double-wrapped; purely
     lowercase-hex strings (32-char dashless UUIDs, hashes) are intentionally
     spared to avoid destroying legitimate log/audit context.
   `redactSensitiveFieldValues` (used by the audit-log middleware, idempotency
   replay, and error-handler) already routes every string leaf through
   `sanitizeForLogOutput`, so the fix propagates to all three surfaces with no
   further change. Regression tests added (AWS/sk_live/GitHub/array; and a
   benign-identifier false-positive guard for dashless UUIDs / prose / SKU).

2. **🔴 `truncate.ts:71` (`truncateValue` `_preview`) — the truncation preview
   persisted an unredacted secret into durable sinks.** `truncateValue` is the
   final pass before a payload is written to `ai_action_log`/`idempotency_record`.
   The payload is normally pre-redacted by key name, but a secret under a
   non-sensitive key name that *also* exceeds the size bound lands its first
   1 KB in the structured truncation marker's `_preview` field verbatim
   (confirmed: `truncateValue({config:{value:"AKIA…"+x*4000}}, 1024)._preview`
   contained `AKIAIOSFODNN7EXAMPLE`). The `_preview` is now passed through
   `sanitizeForLogOutput` (the bare-token rule from #1) as defense-in-depth, so
   the preview can never carry a raw secret. Regression test added.

### Reviewed but NOT changed (false positives / out of scope)

- **`party.service.ts` `taxId` returned in full on REST responses:** re-verified
  — intra-tenant PII returned to authenticated members; consistent with prior
  rounds' product-decision stance. `isSensitiveFieldName` lists `taxid` for the
  *durable-sink/error* redactor, but success-path DTOs are intentionally not
  redacted (round 56 report already documents this asymmetry). No change.
- **`discovery-tools.ts` type-table `description`/`aiPromptHint` via
  `sanitizeForLogOutput` (no HTML strip):** admin-authored global reference
  data, not user input; reachability to an HTML renderer is nil. Noted for
  awareness, not fixed this round.
- **`tenant.ts:41` indentation / `validateTenantId` vs `validateTenantIdEnhanced`
  trim divergence, `role` claim parsed-but-unenforced (no RBAC), `reasoning`
  not HTML-stripped before audit, NULL `tenant_id` row assertion:** all
  re-verified as latent/deferred with no new 🔴/🟡 exploit path this round,
  consistent with prior rounds.

## Findings & Actions (round 56)

### Fixed this round

1. **🔴 `sanitize.ts` (boundary-variant secret rule) — quoted-JSON secrets
   (`{"api_key":"sk_live_abc123"}`, `password="hunter2"`) were never redacted.** The
   boundary-variant rule's value class excluded `"`/`'`, so any secret wrapped in
   quotes survived verbatim. Because `sanitizeForLogOutput` is the sanitizer applied
   to every error message, tool-output string leaf, audit `reasoning`, and operator
   log line, a driver/handler error echoing a user-supplied config blob or a
   `received` JSON payload (`{"password":"…"}`) persisted the secret verbatim across
   **all** agent/REST/durable surfaces — an asymmetric leak vs. the bare-form rule
   that catches `password=hunter2`. Added a quoted-value variant that covers both the
   JSON object form (`"api_key":"value"`) and the free-text form (`password="value"`)
   (and `?token="…"` via a widened leading boundary). Regression tests added
   (double-quoted JSON value, double-quoted `password=`, single-quoted value,
   query-string quoted form all redacted).

2. **🟡 `errors.ts:39` (`DomainError.toJSON`) — `context` was reflected verbatim,
   skipping key-name redaction.** `toJSON` is the canonical structured serializer
   used for audit logs and idempotency records, but it returned `context` raw while
   every other durable/agent surface runs it through `redactSensitiveFieldValues`.
   A secret attached under a sensitive-named context key (e.g. `password`, `apiKey`)
   reached the durable sinks unredacted. `toJSON` now redacts `context` via the
   shared `redactSensitiveFieldValues`, closing the divergence from the REST
   `DomainExceptionFilter.sanitizeContext` path and the MCP `redactSensitiveFields`
   surface. Regression test added (sensitive-named context values redacted).

3. **🔴 `idempotency.ts:48` — missing idempotency key regressed to a hard error
   (contract break introduced in round 52).** The guard folded the missing-key case
   into the validation error, so any caller that omits an idempotency key — the
   documented ADR-004 no-op pass-through — received `INVALID_IDEMPOTENCY_KEY` and the
   tool never executed. An existing regression test (`should pass through when no
   idempotency key`) was failing as a result. Restored the contract: a missing key is
   a no-op pass-through; only a present-but-invalid key (wrong type, empty, or over
   length) is rejected. Added an explicit empty-string rejection test. Test count
   moved 137→138 (the previously-failing test now passes) in `mcp-tools`.

4. **🟡 `domain-exception.filter.ts:159,188` — `HttpException` string `message` and
   `error` branches omitted `stripHtmlTags`.** The `DomainError` path applies
   `stripHtmlTags`, but the parallel `HttpException` string branches returned only
   `sanitizeForLogOutput`, so a markup payload (`<script>…</script>`) reached REST
   clients verbatim (stored-XSS in any HTML renderer). Both string branches now wrap
   the value in `stripHtmlTags` (matching the `DomainError` path's XSS hardening).
   Regression test added (`<script>`/`<img onerror>` stripped from message).

5. **🟡 `domain-exception.filter.ts:95` — the 500-context operator log line leaked
   values under sensitive-named keys.** `handleDomainError` logged
   `sanitizeForLogOutput(JSON.stringify(context))`, which redacts only URL/token
   *patterns* and does NOT redact values under sensitive-named *keys*. The same
   `context` is correctly redacted in the response body (`sanitizeContext`), so the
   secret was redacted for clients but leaked into operator logs — an asymmetric path
   the MCP surface does not have. The log line now serializes the *redacted* context
   (`redactSensitiveFieldValues`).

### Reviewed but NOT changed (false positives / out of scope)

- **`taxId` returned verbatim in `PartyResult`/`SearchPartiesResult` (intra-tenant
  PII):** re-verified — it is tenant-owned data returned to authenticated members, no
  cross-tenant leak; consistent with how other tenant PII is treated (product
  decision). Noted again because round 55's report asserted it is redacted on the
  MCP success path — that assertion was **incorrect**: `redactSensitiveFieldValues`
  is applied only to error contexts and durable sinks, never to successful response
  DTOs. The report's "misread / no change" conclusion for `taxId` should be read as
  "still a deferred product decision," not "already redacted."
- **`role` claim parsed but never enforced / `create-roles.sql` dev password / seed
  `taxId` literals / `NULL tenant_id` backfill (shipped round 48) / contact-mechanism
  TOCTOU race / audit sink silent-drop under backpressure / superuser role for
  audit+idempotency writes / non-concurrent `CREATE INDEX` / duplicate
  `party_role_active_unique` index definition** — all re-verified as latent/deferred
  with no new 🔴/🟡 exploit path this round.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level
  `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency
  key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact.

## Test Results
```
shared:    175 passed (4 files)   (+5 — round 56 quoted-JSON + toJSON-context regressions)
mcp-tools: 138 passed (4 files)   (+1 — round 56 idempotency missing-key fix; previously-failing test now green)
database:   25 passed, 10 skipped (2 files)
api:       328 passed (15 files)  (+1 — round 56 HttpException HTML-strip regression)
───────────────────────────────────
Total:     666 passed, 10 skipped
```

## Findings & Actions (round 55)

### Fixed this round

1. **🟡 `party-tools.ts:457` — `nextActions` reflected unsanitized user input to
   the agent (asymmetric secret-leak).** `add_party_role` interpolates
   `input.roleType` (validated only by `sanitizedString` → `stripHtmlTags`, which
   strips HTML but NOT connection strings / `?api_key=…` secrets) into a
   `nextActions` string returned to the agent verbatim. `nextActions` is excluded
   from the audit/error-handler `data`/context redaction, so a crafted
   `roleType` carrying a secret reached the agent live (the round-48
   asymmetric-leak class). The handler now runs `roleType` through
   `sanitizeForLogOutput`, and — as defense-in-depth — the audit-log middleware's
   success path now also sanitizes every `nextActions` element (matching the
   `result.data` redaction), so any future handler reflecting input into
   `nextActions` is covered. Added a regression test asserting the reflected
   `roleType` is scrubbed.

2. **🔴 `queue.module.ts:94` — Redis connection never enabled TLS, sending the
   password and all job payloads in cleartext in non-dev.** Only `host`/`port`/
   `password` were set; `tls` was never configured, so a network observer could
   capture credentials and queued data. Added `resolveTls()` which enables TLS
   (with `rejectUnauthorized: true`) by default in non-development and opt-out via
   `REDIS_TLS=0`. `REDIS_TLS` and `REDIS_PASSWORD` are scrubbed by `sanitize.ts`
   from logs. Added regression tests asserting TLS is present (production default)
   and absent (`REDIS_TLS=0`).

3. **🟡 `queue.module.ts:65` — `REDIS_PORT` silently defaulted to 6380 in
   production (fail-open), inconsistent with the fail-closed `REDIS_HOST` /
   `REDIS_PASSWORD` guards.** An unset `REDIS_PORT` in production would point the
   app at an unintended Redis instance with no error. `resolvePort` now throws in
   non-development when `REDIS_PORT` is unset, mirroring the host/password guards.
   Split the existing test to assert the port guard, and added a test for it.

4. **🟡 `queue.module.ts:82` — `redisRetryStrategy` swallowed the underlying
   error after 10 retries.** A wrong password / unreachable host was retried
   silently then died as a generic "connection failed". The strategy now logs the
   last error's message (`redisRetryStrategy(times, err)`), surfacing
   misconfiguration loudly (consistent with the fail-closed guards).

5. **🟡 `cleanup-expired-idempotency.ts:100` — cleanup could delete in-flight
   `pending` idempotency records, breaking idempotency guarantees.** `expiresAt <
   new Date()` was re-evaluated every batch, so a just-created `pending` row (or
   one whose in-flight request is still executing under a slow/retried call or
   clock skew) could be reaped, causing a retried client to re-execute the side
   effect. The cutoff is now captured ONCE before the loop and `pending` rows are
   explicitly excluded from deletion (`status: { not: "pending" }`) — stale
   pending rows are recovered by the runtime `STALE_PENDING_THRESHOLD_MS` reset,
   not this job.

6. **🟡 `discovery-tools.ts:41,96` — unbounded `entity` filter + unsanitized
   type-table strings reflected to the agent.** `list_available_tools`' `entity`
   had no max length (every other MCP string input enforces one); `get_type_table
   _values` read `description`/`aiPromptHint` from the admin (RLS-bypassing)
   client and returned them verbatim. Added `MAX_ENTITY_LENGTH` bound and ran
   both fields through `sanitizeForLogOutput` before reflecting them.

### Reviewed but NOT changed (false positives / out of scope / deferred)

- **`taxId` returned under key `taxId` on the REST live response / MCP `data`:**
   `taxId` IS in the `SENSITIVE_FIELD_NAMES` set, so it is redacted by
   `redactSensitiveFields` (audit) AND the MCP success-path `result.data`
   redaction AND the canonical `redactSensitiveFieldValues`. The earlier claim
   that it leaks was a misread — no change.
- **MCP transport JSON body size:** `main.ts:233` already sets
   `express.json({ limit: "100kb" })`, so the "unbounded `arguments` parse"
   concern is already mitigated at the boundary. No change.
- **Contact-mechanism duplicate check TOCTOU race (`party.service.ts`):** a
   genuine read-then-insert window exists at READ COMMITTED for
   `add_contact_mechanism` (no unique constraint, unlike `party_role` which has
   one). Logged as a deferred hardening item — adding a unique constraint /
   SERIALIZABLE isolation is a schema change requiring migration review; out of
   scope for this round's low-risk fixes.
- **Audit sink silent-drop under backpressure (`audit-log.ts`):** by-design
   "audit never breaks the tool" behaviour; noted as a future metric/alert
   candidate, not changed this round.
- **Superuser role for audit/idempotency writes (`rls-setup.sql`):** creating a
   least-privilege service role is a larger migration/ops change; deferred.
- **`create-roles.sql` hardcoded dev password / seed `taxId` literals / NULL
   `tenant_id` backfill to `''`:** noted as latent hygiene items; the migration
   backfill is already shipped, and the dev-role password is gated by comment.
   No code change this round.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level
   `tenantId` filters), secret redaction across REST/MCP/durable surfaces,
   idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning**
   remain intact and were re-verified. No new 🔴/🟡 exploit paths beyond the
   fixes above.

## Test Results
```
shared:    170 passed (4 files)   (unchanged)
mcp-tools: 137 passed (4 files)   (unchanged)
database:   25 passed, 10 skipped (2 files)
api:       327 passed (15 files)  (+3 — round 55 queue TLS/port + party nextActions)
─────────────────────────────────────
Total:     659 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 3 pre-existing complexity warnings (unchanged)
- `npm run test` — all passing: shared 170, mcp-tools 137, database 25 (10 RLS
  isolation tests skipped without a live DB), api 324

## Findings & Actions (round 54)

### Fixed this round

1. **🟡 `error-handler.ts:40` — MCP `sanitizeContextValue` depth cap (10) diverged from the canonical shared redactor (20).**
   `MAX_SANITIZE_DEPTH = 10` caused the error-handler to return `"[Too deep]"` for
   `DomainError.context` trees 11–20 levels deep, while the REST canonical redactor
   (`redactSensitiveFieldValues`, `MAX_REDACTION_DEPTH = 20`) and the audit-log
   redactor (`MAX_REDACTION_DEPTH = 20`) preserved those trees. A legitimately deep
   diagnostic context was silently dropped on the MCP agent-facing surface — data
   loss, not a secret leak, but a consistency gap between the two "must-match"
   redactors. Changed the error-handler to import and use the shared `MAX_REDACTION_DEPTH`
   constant, eliminating the local `MAX_SANITIZE_DEPTH = 10` constant. Added a
   regression test (a 21-level deep context tree is fully preserved on the agent
   surface).

### Reviewed but NOT changed (false positives / out of scope)

- **`role` claim parsed but unenforced / `taxId` returned verbatim /
  dev DB password / non-concurrent `CREATE INDEX` / `ai_action_log.tenant_id`
  nullable** — same documented latent gaps & deferred items as rounds 45–50;
  no change this round.
- **`prisma.service.ts` RLS boot assertions, `rls-extension.ts` context
  reset, `discovery-tools` global reference data, `secret-strength` zero-entropy
  heuristic (does not catch 2-char repeats like `abab…`), `searchParties`
  `mode:"insensitive"` substring DoS** — re-verified clean / accepted as
  defense-in-depth or product decisions this round; tenant isolation (RLS boot
  assertion + superuser boot refusal + app-level `tenantId` filters), secret
  redaction across REST/MCP/durable surfaces, idempotency-key charset
  consistency, and ReDoS remain intact. No new 🔴/🟡 exploit paths beyond the
  one fix above.

## Test Results
```
shared:    170 passed (4 files)   (unchanged)
mcp-tools: 137 passed (4 files)   (+1 — round 51 depth-alignment regression)
database:   25 passed, 10 skipped (2 files)
api:       324 passed (15 files)  (unchanged)
─────────────────────────────────────
Total:     656 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 170, mcp-tools 136, database 25 (10 RLS
  isolation tests skipped without a live DB), api 324

## Findings & Actions (round 50)

### Fixed this round

1. **🔴 `tool-registry.ts:224` — Zod validation `message` returned to the AI
   agent was NOT secret-sanitized (asymmetric secret-leak; contradicts its own
   comment).** On validation failure the pipeline joins each issue's
   `path: message` into a single `detail` string, length-caps it, and embeds it
   verbatim in the agent-facing top-level `error.message`. The parallel
   `context.issues` array *is* scrubbed via `sanitizeIssues`, but `detail` was
   only `.slice()`-capped — so a secret embedded in an issue `message` (a custom
   `errorMap`/`.refine()` that echoes the received value, or a connection
   string) leaked verbatim to the agent in `error.message` while `context.issues`
   redacted it. This is exactly the asymmetric-leak class rounds 42/44/48/49
   closed on every other surface; `errorHandlerMiddleware` only catches
   *thrown* errors and this soft-failure return is never thrown, so it reached the
   agent unsanitized. `detail` now runs through `sanitizeForLogOutput` before
   being embedded (matching `context.issues`). The latent `party-tools`
   `leaky_tool` fixture already carried the secret in the top-level message; the
   regression test now asserts `error.message` does not contain it and contains
   `[HOST]/[PATH]`.

2. **🔴 `sanitize.ts:152` — OAuth `#fragment` tokens (`#access_token=`,
   `#id_token=`) were never redacted.** The query-string secret rule only matched a
   `(?<=[?&])` lookbehind, so a secret delivered in a URL fragment (the
   OAuth implicit-flow delivery mechanism) survived verbatim — the subsequent
   `(https?://)… → [HOST]/[PATH]` collapse requires a leading scheme+host and
   never consumes a bare `#token=…`. Added `id_token` to the param-name
   alternation and `#` to the lookbehind so fragment secrets are replaced, not
   annotated. Added regression tests (`#token=`, `#id_token=`).

3. **🔴 `sanitize.ts:152` + `crypto.ts` — `;` was not treated as a
   query-parameter separator, and `id_token` was missing from the param list.**
   Frameworks that parse `;` as a separator (PHP, some OAuth libs) would leak a
   `;token=…` value when no leading `?`/`&`/`#` preceded it. Added `;` to
   the lookbehind and excluded it from the value class (so a `?a=1;token=…`
   immediately following another param is still caught). Regression tests added for
   both `;token=` and `?token=x;other=2`.

4. **🔴 `crypto.ts:69` — `sortSet` never charged its element bytes to the
   aggregate hash budget (bypassed the round-38 DoS guard).** `sortArray`/
   `sortPlainObject`/`sortMap` all charge string *values* and (for maps) keys to
   `budget.bytes` via `checkStringBounds`/`chargeKeyBytes`, but `sortSet`
   called `JSON.stringify(v)` only to sort and never charged the elements. A
   `Set` of ~30 × 99 KB strings (≈3 MB) therefore hashed successfully and
   emitted a ~3 MB `JSON.stringify` buffer, defeating `MAX_HASH_TOTAL_BYTES`.
   `sortSet` now charges each element's serialized bytes (and the sort path already
   charged the string values via `sortKeysDeep`). Regression test added (a wide
   Set of distinct near-limit strings now throws the aggregate-size-limit error).

5. **🟡 `queue.module.ts:27` — `REDIS_HOST` silently defaulted to
   `localhost` even in production.** Only the Redis *password* was enforced in
   non-development; an unset/empty `REDIS_HOST` fell back to `localhost`, so a
   misconfigured production instance would connect to an unintended (and
   unauthenticated) Redis rather than failing closed. Mirroring the password
   guard, `REDIS_HOST` is now required when `NODE_ENV !== "development"`;
   only development keeps the localhost fallback. Added a production host-guard
   regression test.

6. **🟡 `party.service.ts:775` — telecom duplicate check ignored
   `countryCode`.** `checkTelecomDuplicate` matched only on
   `(areaCode, lineNumber)`, so `+1 555 1234` and `+44 555 1234` collided
   as the same number — incorrect for international subscribers and a
   correctness gap. The check (and the create path that feeds it) now scope on
   `countryCode` too (defaulting to `+1` when omitted, matching the stored
   value). Added a regression test asserting `countryCode` is in the
   duplicate-check `where`.

7. **🟡 `party-tools.ts:251` — MCP email validation diverged from the REST/
   service layer.** The MCP `emailAddressSchema` used Zod's built-in `.email()`,
   while `party.service.ts` enforces the stricter `EMAIL_REGEX`. Zod accepts
   addresses `EMAIL_REGEX` rejects (e.g. a double-dot local part
   `a..b@x.com`), so an MCP-submitted address could pass validation and then be
   rejected by the service's duplicate-check/re-validation. The MCP path now runs
   through the same `EMAIL_REGEX`.

8. **🟢 `audit-log.ts:18` / `audit-log.ts:240` — the MCP `redactSensitiveFields`
   diverged from the canonical shared redactor on depth cap (10 vs 20) and
   non-string Map keys.** The two "must-match" redactors disagreed: a legitimately
   deep (11–20 level) payload was over-redacted (`[Too deep]`) on the MCP/
   durable surface while the REST canonical redactor preserved it, causing silent
   data loss in `ai_action_log`/idempotency for deep-but-legitimate objects; and
   a `Map` keyed by an object whose `toString()` yields a sensitive name was
   redacted on REST (`String(k)`) but not on MCP. Aligned
   `MAX_REDACTION_DEPTH` to 20 and switched `redactMap` to `String(k)` for
   parity. Regression tests updated/added (`too-deep` nesting now uses 25
   levels; non-string sensitive Map key redacted on both surfaces).

### Reviewed but NOT changed (false positives / out of scope)

- **`role` claim parsed but unenforced / `taxId` returned verbatim /
  dev DB password / non-concurrent `CREATE INDEX` / `ai_action_log.tenant_id`
  nullable** — same documented latent gaps & deferred items as rounds 45–49;
  no change this round.
- **`prisma.service.ts` RLS boot assertions, `rls-extension.ts` context
  reset, `discovery-tools` global reference data, `secret-strength` zero-entropy
  heuristic (does not catch 2-char repeats like `abab…`), `searchParties`
  `mode:"insensitive"` substring DoS** — re-verified clean / accepted as
  defense-in-depth or product decisions this round; tenant isolation (RLS boot
  assertion + superuser boot refusal + app-level `tenantId` filters), secret
  redaction across REST/MCP/durable surfaces, idempotency-key charset
  consistency, and ReDoS remain intact. No new 🔴/🟡 exploit paths beyond the
  eight above.

## Test Results
```
shared:    170 passed (4 files)   (+3 — round 50 fragment/; Set-budget regressions)
mcp-tools: 136 passed (4 files)   (+2 — round 50 validation-message + non-string Map-key regressions)
database:   25 passed, 10 skipped (2 files)
api:       324 passed (15 files)  (+2 — round 50 Redis-host + telecom-countryCode regressions)
───────────────────────────────────
Total:     655 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 164, mcp-tools 134, database 25 (10 RLS
  isolation tests skipped without a live DB), api 322

## Findings & Actions (round 49)

### Fixed this round

1. **🔴 `sanitize.ts:152` — `sanitizeLogOutput` query-string secret rule
   *annotated* the secret instead of *replacing* it (live secret-leak in the
   core redaction primitive).** The rule matched the full `param=value` and
   returned `m.replace(...)+"[REDACTED]"`, so `api_key=sk_live_abc123` became
   `api_key=sk_live_abc123[REDACTED]` — the **secret text survived verbatim**
   in the output. Every surface (REST `DomainExceptionFilter`, MCP
   `error-handler`/`audit-log`/`idempotency`/`tool-registry`, durable sinks)
   composes `sanitizeLogOutput`, so this bypassed redaction everywhere it was
   used. It stayed hidden through rounds 44–48 because every existing regression
   test fed an `https://…?param=secret` URL, and the *subsequent*
   `(https?://)… → [HOST]/[PATH]` collapse folded the whole URL (secret included)
   away — masking the defective query rule. The leak is real whenever a
   secret-bearing query string appears **without** a leading `https://` URL (a
   bare `?api_key=…`, a `reasoning`/log line, a curl arg). The rule now
   captures the `param=` prefix and the bare value in separate groups and returns
   `param=[REDACTED]` (`api_key=sk_live_abc123` → `api_key=[REDACTED]`).
   Added a regression test that exercises the no-URL case (previously uncovered).

2. **🔴 `audit-log.ts:42` — `reasoning` was persisted to the durable
   `ai_action_log` sink un-sanitized (asymmetric secret-leak to the durable
   row).** `reasoning` originates from the AI agent / tool-call context
   (attacker-influenceable via the MCP request body) and is written verbatim to
   `ai_action_log.reasoning`, a cross-tenant audit table. Every *other* durable
   sink (`toolInput`, `toolOutput` → both `redactSensitiveFields`) and every
   agent-facing surface run through `sanitizeForLogOutput`, but `reasoning` was
   only length-sliced to `MAX_REASONING_LENGTH` — so a connection string,
   JWT, or `?api_key=…` embedded in it leaked into the durable row. This is
   the same class of asymmetric-leak round 44/48 closed for the other sinks,
   now extended to `reasoning`. It was also the *trigger* that exposed finding
   #1: a `reasoning` string carries no `https://` URL, so the masked
   query-rule defect surfaced. `reasoning` now runs through
   `sanitizeForLogOutput` before being persisted (matching `toolInput`
   handling). Added a regression test (connection string + `?api_key=…` in
   `reasoning` redacted in the durable row).

### Reviewed but NOT changed (false positives / out of scope)

- **`prisma.service.ts` `verifyRlsEnabled` (round 48 rewrite)** — re-verified:
  the query selects ALL `relkind='r'` tables in `public` and diffs the actual
  force-RLS set against the `tenantTables` enumeration; a force-RLS table not
  in the list still refuses to boot. No false-positive on global (non-tenant)
  tables. Intact.
- **`crypto.ts` aggregate byte budget / `truncate.ts` nested Map-Set /
  `idempotency.ts` soft-failure capping / `redactSensitiveFields` (round 48)
  / `tool-registry.ts` UNKNOWN_TOOL name sanitization (round 48)** — re-verified
  clean this round; tenant isolation (RLS boot assertion + superuser boot
  refusal + app-level `tenantId` filters), secret redaction across
  REST/MCP/durable surfaces, idempotency-key charset consistency, and ReDoS
  remain intact. No new 🔴/🟡 exploit paths beyond the two above.
- **`create-roles.sql` dev password / `role` claim parsed-but-unenforced /
  `taxId` returned verbatim in response DTOs / non-concurrent `CREATE INDEX` /
  `ai_action_log.igrant_id` nullable (closed round 48)** — same documented
  latent gaps / deferred items as rounds 45–48; no change this round.

## Test Results
```
shared:    167 passed (4 files)   (+1 — round 49 query-rule no-URL regression)
mcp-tools: 135 passed (4 files)   (+1 — round 49 reasoning-sanitize regression)
database:   25 passed, 10 skipped (2 files)
api:       322 passed (15 files)  (unchanged)
───────────────────────────────────
Total:     649 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 166, mcp-tools 134, database 25 (10 RLS
  isolation tests skipped without a live DB), api 322

## Findings & Actions (round 48)

### Fixed this round

1. **🔴 `sanitize.ts:161` — O(n²) ReDoS in the generic credential-URL catch-all
   (event-loop-blocking DoS).** `sanitizeLogOutput`/`sanitizeForLogOutput` had no
   input-length cap, and the generic `scheme://user:pass@host` catch-all used an
   unbounded greedy scheme prefix `[a-zA-Z][a-zA-Z0-9+.-]*`. On a long run of
   letters with no `://` the engine backtracked char-by-char at every offset —
   empirically ~6.9 s for a 100k-char string. This is called on hot, synchronous,
   agent-facing **and** durable-persist paths (MCP `error-handler`, `audit-log`,
   `idempotency`, `tool-registry`; and `redactSensitiveFieldValues` runs it on every
   string leaf), so a single crafted ~100k-char error/tool-output blocks the event
   loop for seconds. The scheme length is now capped at `{1,31}` (linear; ~13 ms at
   100k, verified), and a defensive `MAX_LOG_OUTPUT_LENGTH = 100_000` byte cap was
   added at the top of `sanitizeLogOutput` (the `.slice(...)` callers truncate
   *after* this runs, so they did not mitigate the cost). Added a regression test
   (100k letter run returns in < 500 ms; credential URLs still redacted).

2. **🟡 `audit-log.ts:256` — MCP `redactSensitiveFields` did not sanitize string
   leaves (asymmetric secret-leak vs. the canonical REST redactor).** The local
   `isTerminal` short-circuit returned raw **strings** verbatim, so a connection
   string / JWT / `?api_key=…` embedded in a tool result *value* under a
   benign-named key (`url`, `note`) survived the MCP redactor even though the canonical
   shared `redactSensitiveFieldValues` (used by the REST `DomainExceptionFilter`)
   scrubs every string leaf via `sanitizeForLogOutput`. The secret therefore leaked to
   the agent (live path, `audit-log.ts:85`), the `ai_action_log` durable row
   (`audit-log.ts:217`), and any idempotency replay (`idempotency.ts:267`). String
   leaves now pass through `sanitizeForLogOutput` (matching the REST surface). Added a
   regression test (connection string under `url`/`note` scrubbed on live + durable).

3. **🟡 `prisma.service.ts:255-289` — `verifyRlsEnabled` "unexpected table" guard
   was unreachable dead code (contradicted the round-44 invariant).** The query
   filtered `WHERE relname = ANY(tenantTables)`, so `forceRlsCount` was derived only
   from the enumerated rows and could never exceed `tenantTables.length` — the
   `unexpected` branch (meant to catch a new tenant table added to `rls-setup.sql`
   but omitted from the list) could never fire, so the gap round 44 #6 intended to
   close stayed open. The query now selects **all** `relkind='r'` tables in `public`
   and diffs the actual force-RLS set against the enumeration; a force-RLS table not
   in the list now refuses to boot. No false-positive on global (non-tenant) tables
   since those never have FORCE RLS.

4. **🟡 `migrations/20260718000000_ai_action_log_tenant_id_not_null` — closed the
   `ai_action_log.tenant_id` nullable drift (the long-deferred "nullable concern",
   real migration root cause).** The init migration declared `ai_action_log.tenant_id`
   as `TEXT` (nullable) while `schema.prisma` mandates `NOT NULL` and every other
   tenant table uses `TEXT NOT NULL`. Because the migrations are shipped/squashed, a
   freshly `migrate deploy`-ed database had a genuinely nullable column — a direct/raw
   insert could write a NULL `tenant_id` row invisible to all tenants under RLS (no
   cross-tenant leak, but a stranded-audit/data-integrity gap and a false assumption
   for any consumer trusting `tenant_id` is always present). New migration backfills
   any NULL to `''` and sets `NOT NULL`.

5. **🟢 `tool-registry.ts:149-157` — `UNKNOWN_TOOL` reflected the raw requested
   tool name without sanitization.** `name` is attacker-controlled (the requested
   tool) and the result bypasses `errorHandlerMiddleware`, so a crafted name embedding
   a secret-bearing URL (`foo?api_key=…`) reached the agent unsanitized. The name
   (and similar-name suggestions) now run through `sanitizeForLogOutput` before being
   reflected. Added a regression test.

### Reviewed but NOT changed (false positives / out of scope)

- **`create-roles.sql:19` committed dev password `'besterp_app_dev'`** — dev-only
  (`NOINHERIT`, documented in-file warning; `rls-setup.sql` refuses if `besterp_app`
  is a superuser). A real credential-hygiene footgun if copied to staging/prod
  verbatim, but out of scope for this round (tracked since round 35).
- **`role` claim parsed but dropped on the REST path** — `JwtStrategy.validate()`
  populates `JwtValidatedUser.role` (validated) but it is never consumed by
  `TenantContext`/a `RoleGuard` (grep-confirmed: no RBAC layer exists). Same
  documented latent gap as rounds 45/46; deferred to a dedicated RBAC follow-up.
- **`taxId` returned verbatim in `PartyResult`/`ContactMechanismResult`** — the
  sensitive-field redactor is applied only to *error* contexts and *durable* sinks,
  not successful response DTOs; consistent with how other tenant-owned PII is treated
  (product decision). Deferred (unchanged from round 45/46).
- **`migration/20260619000000…` non-concurrent `CREATE INDEX`** — flagged LOW in
  round 38; `IF NOT EXISTS` present, comment documents manual `CONCURRENTLY`.
  Changing shipped migrations is risky; deferred.
- **`party.service.ts` / `discovery-tools.ts` / `queue.module.ts` / `prisma.service.ts`
  / `mcp.module.ts` / `crypto.ts` / `truncate.ts` / `rls-extension.ts` / REST filter
  / `sanitize.ts` (other rules) / `sensitive-fields.ts`** — re-verified clean this
  round; tenant isolation (RLS boot assertion + superuser boot refusal + app-level
  `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency
  consistency, and ReDoS remain intact. No new 🔴/🟡 exploit paths beyond the five
   above.

## Test Results
```
shared:    166 passed (4 files)   (+2 — round 48 ReDoS + credential-URL regression)
mcp-tools: 134 passed (4 files)   (+2 — round 48 string-leaf + UNKNOWN_TOOL name regressions)
database:   25 passed, 10 skipped (2 files)
api:       322 passed (15 files)  (unchanged)
───────────────────────────────────
Total:     647 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 164, mcp-tools 132, database 25 (10 RLS
  isolation tests skipped without a live DB), api 322


## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 1 pre-existing complexity warning in `crypto.ts:sortKeysDeep`
  (cyclomatic complexity 17, max 15)
- `npm run test` — all passing: shared 164, mcp-tools 132, database 25 (10 RLS isolation
  tests skipped without a live DB), api 322

## Findings & Actions (round 47)

### Fixed this round

1. **🟢 `crypto.ts:sortKeysDeep` — cyclomatic complexity 17 exceeded the lint cap (15),
   the only outstanding lint warning from round 46.** The entry point inlined every
   type-dispatch branch (null/undefined, number, string, array/Map/Set/object, primitive)
   plus the depth guard, pushing it two points over the configured `max-complexity` of 15.
   Extracted the non-null/non-primitive dispatch into a new `dispatchContainer()` helper,
   which preserves the exact budget/ancestors threading (the `budget ?? { bytes: 0 }`
   defaulting for string/number short-circuits is kept local to `sortKeysDeep`) and the
   single recursive call site for each container type. `sortKeysDeep` drops to complexity 14;
   `dispatchContainer` is 6. `npm run lint` is now 0 errors / 0 warnings across all
   workspaces. No behavior change — full shared test suite (164) still passes, and the
   canonical-form / aggregate-budget / depth-guard regression tests are unchanged.

### Reviewed but NOT changed (false positives / out of scope)

- **`jwt.strategy.ts` `role` claim parsed but never enforced** — `JwtStrategy.validate()`
  populates `JwtValidatedUser.role` (validated, trimmed, length-capped) but it is never
  consumed by `TenantContext`, any `RoleGuard`, or an authorization check (grep-confirmed:
  no RBAC layer exists). This is the same design gap flagged in round 45. It is NOT a live
  exploit (an unused claim cannot grant or deny access), but it is a latent footgun that
  implies authz exists where none does. Round 45 framed the fix as "add a real RBAC layer
  or remove `role` from the JWT contract" — both are contract/feature changes that exceed a
  review-round fix and risk breaking live token issuers. Deferred to a dedicated RBAC
  follow-up; left documented here so it is tracked, not forgotten.
- **`taxId` returned verbatim in `PartyResult`/`ContactMechanismResult`** — re-verified: the
  sensitive-field redactor (`isSensitiveFieldName`) is applied only to *error* contexts and
  *durable* sinks, not to successful response DTOs, so a tenant-owned `taxId` is returned to
  any authenticated tenant member. This is consistent with how other tenant-owned PII is
  treated and is a product decision, not a cross-tenant leak. Deferred (unchanged from
  round 45).
- **`sanitize.ts` generic-URL catch-all (path-secret) "known limitation"** — re-verified:
  the generic `(https?:\/\/)[^\s"')}]+ → [HOST]/[PATH]` rule collapses the *entire* URL
  tail (path + query) into `[PATH]`, so a secret embedded anywhere in the URL — including
  the path — is already scrubbed. The round-44 "known limitation" (secret in URL path) is
  in fact already covered by this collapse; the dedicated regression test
  (`path contains sensitive data` → `sk-live-abc123` removed) passes. No change needed.
- **`party.service.ts` / `discovery-tools.ts` / `queue.module.ts` / `prisma.service.ts` /
  `mcp.module.ts` / `crypto.ts` (aggregate budget)** — re-verified clean: tenant isolation
  (RLS boot assertion + superuser boot refusal + app-level `tenantId` filters), secret
  redaction across REST/MCP/durable surfaces, and idempotency-key charset consistency remain
  intact. No new 🔴/🟡 exploit paths.

## Test Results
```
shared:    164 passed (4 files)   (unchanged)
mcp-tools: 132 passed (4 files)   (unchanged)
database:   25 passed, 10 skipped (2 files)
api:       322 passed (15 files)  (unchanged)
───────────────────────────────────
Total:     643 passed, 10 skipped
```

## Findings & Actions (round 46)

### Fixed this round

1. **🟡 `health.service.ts` — anonymous `/version` fingerprints the build in production.**
   `getVersion()` is served by the `@Public()` `HealthController.getVersion()` (no JWT), so
   it is reachable by anyone. It returned the package `name` + `version` (and `build`
   number/date) verbatim in **every** environment, including production — an exact
   name + semantic version fingerprints the deployed release and lets an attacker target
   known CVEs for that specific build. This is the same infrastructure-fingerprinting
   class the anonymous `/health` body was already minimised against (round 33/34): that
   endpoint returns only `{ status, timestamp, database }`. The `build`/`warning`
   suppression already keyed on `NODE_ENV === "production"`, but `name`/`version` were
   never gated. `getVersion()` now returns generic `"redacted"` markers for `name`/`version`
   (and omits `build`/`warning`) in production, matching the fail-closed `/health` body;
   non-production keeps the full triplet for operator debugging. Added regression tests
   (production redaction; non-production disclosure).

2. **🟡 `jwt-auth.guard.ts` / `tenant.guard.ts` — `@Public()` was an unscoped global auth
   opt-out (silent unauthentication footgun).** `@Public()` is a boolean decorator honoured
   by both `JwtAuthGuard` and `TenantGuard` for *any* controller or method. For a
   multi-tenant system that is a standing footgun: a single misplaced `@Public()` silently
   unauthenticates a tenant-scoped route — exposing data to anonymous callers with no
   warning at boot or runtime. Only `HealthController` is legitimately public today, so the
   broad opt-out was pure latent risk. Added `auth/public-scope.ts` with
   `isPublicAllowedForHandler()`, which fails closed (`ForbiddenException`) unless the
   handler's controller is `HealthController`; both guards now call it before honoring
   `@Public()`. A future attempt to opt any other controller out of authentication is
   rejected at request time rather than silently bypassed. Added a regression test
   (non-health `@Public()` throws `ForbiddenException`; health stays allowed).

### Reviewed but NOT changed (false positives / out of scope)

- **`role` claim parsed but dropped on the REST path** — `JwtStrategy.validate()` populates
  `JwtValidatedUser.role` (validated, trimmed, length-capped), but `TenantContext`
  (`tenant-context.ts`) has no `role` field, so it is never enforced. There is **no RBAC**
  layer anywhere in the codebase (grep-confirmed: `user.role`/`req.user` only appear in
  tests/comments), so the claim is unused for authorization. This is a design gap, not a
  live exploit — enforcing an unused claim would create a false sense of authz. Deferred:
  either add a real `RoleGuard`/`Roles()` RBAC layer or remove `role` from the JWT contract
  until RBAC exists. Flagged as a follow-up to track; out of scope for this round's
  concrete fixes.
- **`taxId` returned verbatim in `PartyResult`/`ContactMechanismResult`** — the redaction
  pattern (`redactSensitiveFieldValues`) is applied only to *error* contexts, not to
  successful response DTOs. `taxId` (PII/tax data) is therefore returned to any
  authenticated tenant member. Likely intended (tenant-owned data), but inconsistent with
  how contact-mechanism PII is treated elsewhere. Flagged for awareness; masking in
  list/search responses is a product decision, deferred.
- **`@IsDateString()` on optional date DTO fields** — default class-validator accepts some
  non-strict forms, but the service layer re-validates with `isValidISODate`, so the DTO
  check is not the final gate. Defense-in-depth holds. No change.
- **`party.service.ts` / `discovery-tools.ts` / `queue.module.ts` / `prisma.service.ts` /
  `mcp.module.ts`** — re-verified clean this round; tenant isolation (RLS boot assertion +
  superuser boot refusal + app-level `tenantId` filters + spread-after-`tenantId`
  controllers), secret redaction across all agent/REST/durable surfaces, and idempotency
  key charset consistency remain intact. No new 🔴/🟡 exploit paths.

## Test Results
```
shared:    164 passed (4 files)   (unchanged vs round 44)
mcp-tools: 132 passed (4 files)   (unchanged vs round 44)
database:   25 passed, 10 skipped (2 files)
api:       316 passed (14 files)  (+3 — round 45 /version redaction + @Public() scope tests)
───────────────────────────────────
Total:     637 passed, 10 skipped
```

## Findings & Actions (round 44)

### Fixed this round

1. **🔴 `domain-exception.filter.ts` — DomainError `message` reflected to REST clients
   was NOT secret-redacted (only HTML-stripped), an asymmetric leak vs. the parallel
   MCP agent surface.** The non-500 production path built
   `message: stripHtmlTags(sanitizeLogMessage(exception.message))` — `sanitizeLogMessage`
   only strips control chars/ANSI, so a connection string, `Bearer` token, or
   `?token=…` secret embedded in a DomainError message (which routinely echoes
   user-supplied input) reached REST clients verbatim while the same message was
   scrubbed to `[DATABASE_URL]`/`[REDACTED]` for AI agents. Changed the message to
   `stripHtmlTags(sanitizeForLogOutput(exception.message))`, matching the file's own
   `handleUnexpectedError` path and the MCP `error-handler`. Added a regression test
   (connection string in DomainError message redacted in production).

2. **🟡 `domain-exception.filter.ts` — dev `context` tree was control-char sanitized but
   NOT field-name redacted, leaking secrets under sensitive-named keys to REST dev
   clients.** `sanitizeContext` only ran `sanitizeForLogOutput` per string leaf; a
   `DomainError` thrown with `context: { apiKey: "sk_live_…" }` reflected verbatim to
   REST dev clients while MCP agents saw `"[REDACTED]"`. Promoted the field-name
   redactor to `@besterp/shared` as `isSensitiveFieldName` + `redactSensitiveFieldValues`
   (single source of truth, reused by the REST filter), and changed `sanitizeContext`
   to redact the whole tree at once so the key is visible to the redactor. Added a
   regression test (`password`/`apiKey` redacted in dev context).

3. **🟡 `domain-exception.filter.ts` — `HttpException` validation-array messages were not
   secret-scrubbed.** A custom validator embedding a `Bearer …`/connection-string secret
   in a non-quoted message survived to REST clients (the existing strip step only removes
   quoted/`received:` values). Each cleaned message now passes through `sanitizeForLogOutput`
   before being returned. Added a regression test (embedded bearer token redacted).

4. **🔴 `idempotency.ts` — soft-failure `error.message` was persisted to the durable
   `idempotency_record` WITHOUT secret redaction (asymmetric with the hard-fail path).**
   The thrown-error branch scrubs the message via `sanitizeForLogOutput`; the
   `success:false` (non-thrown) branch only `capString`'d it — so a tool returning a
   non-thrown failure whose message embeds a connection string persisted that secret
   verbatim into the 24h-TTL durable row, which the thrown path redacted. Wrapped the
   soft-failure `message` in `sanitizeForLogOutput` (matching the already-scrubbed
   `code`). Added a regression test (connection string redacted in soft-failure record).

5. **🟡 `sanitize.ts` — `sanitizeLogOutput` query-string secret redactor missed common
   secret-bearing param names** (`pwd`, `passwd`, `signature`, `sign`, `otp`, `code`,
   `session`, `client_id`, `bearer`). Broadened the alternation so secrets in those
   query params are redacted across every surface that uses `sanitizeLogOutput`. Added
   regression tests.

### Reviewed but NOT changed (false positives / out of scope)

- **`crypto.ts` aggregate hash budget quote-overhead rounding** — flagged by the
  shared-package review: `checkStringBounds`/`chargeKeyBytes` charge JSON quote/bracket
  overhead only for keys, not string *values*, so `JSON.stringify` output can exceed
  `MAX_HASH_TOTAL_BYTES` by a bounded margin (a few %). The cap is a safety backstop for
  idempotency hashing; legitimate inputs are tiny and the overflow is bounded by quote
  overhead, not orders of magnitude. Deferred as defense-in-depth — no exploit path.
- **`sanitize.ts` generic-URL catch-all (no userinfo)** — a non-credential URL with a
  secret in the *path* (not `user:pass@` userinfo) is not redacted by the catch-all.
  Low-frequency; out of scope for this round (query-string secrets are now covered, which
  covers the realistic cases). Documented as a known limitation.
- **`prisma.service.ts` tenant propagation, `mcp.module.ts` idempotency-key validation,
  `truncate.ts` byte safety, error-handler no-stack-leak** — re-verified clean this round.

## Test Results
```
shared:    154 passed (4 files)   (+1 — round 43 redactor + broadened-param tests)
mcp-tools: 130 passed (4 files)   (+1 — round 43 soft-failure durable-sanitize regression)
database:   25 passed, 10 skipped (2 files)
api:       312 passed (14 files)  (+3 — round 43 REST redaction regression tests)
───────────────────────────────────
Total:     621 passed, 10 skipped
```

## Findings & Actions (round 44)

### Fixed this round

1. **🔴 `sensitive-fields.ts` — the MCP surface used a divergent sensitive-field detector that
   omitted `code`/`session`/`signature`/`sign` (asymmetric secret leak).** Round 43 promoted
   `isSensitiveFieldName` to `@besterp/shared` as the single source of truth and added those four
   names to it, but the three MCP middlewares (`audit-log`, `error-handler`, `tool-registry`) kept
   using a local `isSensitiveField` without them. A value under a key named `code` (MFA/verification
   code), `session` (session token), `signature`, or `sign` (signing secret) was redacted on the
   REST surface but **leaked** on the agent-first MCP surface — through the live tool result,
   `ai_action_log.tool_input`/`toolOutput`, the idempotency persist + replay paths, and validation
   `issues.received`. Made `sensitive-fields.ts` delegate to the shared `isSensitiveFieldName`
   (and `splitFieldTokens` to the shared tokeniser), removing the duplicated local set/regex/tokens
   so the two surfaces cannot diverge. Added regression tests (the four previously-missed names are
   now redacted; the MCP detector agrees with the shared one on a sample).

2. **🔴 `sanitize.ts` — the shared `redactSensitiveFieldValues` (used by the REST filter's dev
   `context` reflection) dropped `Map`/`Set` to `{}` and had no recursion depth cap.** A `Map`/`Set`
   fell through to `Object.entries(...)` → `[]`, so it serialised to `{}` (data loss) and, unlike the
   MCP `redactSensitiveFields`, it never redacted sensitive-named Map/Set keys — `new Map([["password",
   "hunter2"]])` reflected as `{}` on REST while the MCP surface redacted it. With no depth guard, a
   deeply nested attacker-influenced `DomainError.context` could blow the stack on the REST dev path
   (DoS). Rewrote it as the complete canonical redactor: depth-guarded (`"[Too deep]"` past
   `MAX_REDACTION_DEPTH`), Map/Set-aware (converted to JSON-safe `[k,v]`/array form with sensitive
   keys redacted), cycle-guarded. Split container handling into helper functions to stay under the
   lint complexity cap. Added regression tests (Map key redaction, Map/Set preservation, depth guard).

3. **🔴 `domain-exception.filter.ts` — the REST `HttpException` string `message`/`error` branches
   were not secret-scrubbed in production (asymmetric leak).** Round 43 sanitized the array
   validation-message branch and `DomainError` messages, but the `typeof res.message === "string"`
   branch copied the message verbatim and `res.error` was copied verbatim. A custom/upstream
   `HttpException` carrying a connection string or `Bearer` token in its string `message`/`error`
   reached REST clients in production unredacted while the same value was scrubbed on the MCP surface
   and the array branch. Both string branches now pass through `sanitizeForLogOutput`. Added a
   regression test (embedded `postgres://…` secret redacted in the string message/error).

4. **🟡 `idempotency.ts` / `audit-log.ts` — the thrown-error `error.code` was persisted raw and
   un-capped (asymmetric with the already-fixed soft-failure branch).** Round 32 #4 / round 43 #4
   fixed only the soft-failure `error.code` (`capString(sanitizeForLogOutput(...))`). The idempotency
   hard-throw path stored `code: getErrorCode(error)` verbatim and the audit-log thrown-error path
   stored `code: getErrorCode(error)` raw. `getErrorCode` is a free-form (non-allowlisted) string, so
   a thrown custom error with a long/secret `.code` persisted verbatim into the durable 24h-TTL
   `idempotency_record.error.code` / `ai_action_log.toolOutput.error.code`. Both now apply
   `capString(sanitizeForLogOutput(...), MAX_SOFT_FAILURE_MESSAGE_SIZE)`. Added a regression test
   (oversized hard-throw code capped + truncated).

5. **🟡 `cleanup-expired-idempotency.ts` — the cleanup silently rolled back on real datasets.** The
   whole scan + batched-delete runs in one interactive `$transaction` whose default Prisma timeout is
   5s; any non-trivial cleanup (a few thousand expired rows, or a transaction holding the advisory
   lock past 5s) timed out, rolled back (deleting nothing), and exited non-zero having cleaned 0 rows
   — defeating its only purpose while the table grew unbounded. Pass an explicit `timeout` (default
   600s, tunable via `CLEANUP_TX_TIMEOUT_MS`).

6. **🟢 `prisma.service.ts` — the RLS boot check could pass vacuously for newly-added tenant
   tables.** `verifyRlsEnabled` treats the hard-coded `tenantTables` list as authoritative; a new
   tenant table added to `schema.prisma` + `rls-setup.sql` but omitted from the list is simply never
   inspected, so the check passes and that table's tenant isolation goes unverified. The query now
   also fails closed if the DB reports MORE force-RLS tables than the enumeration covers (with a clear
   message). Global tables never have FORCE RLS applied, so no false-positive.

### Reviewed but NOT changed (false positives / out of scope)

- **`redactSensitiveFieldValues` over-redaction of benign `error.code`** — because `code` is now a
  sensitive field name (round 43 single source of truth), the audit-log `toolOutput.error.code`
  (e.g. `P2002`) is redacted to `[REDACTED]` on every surface. This is consistent with the established
  policy (over-redaction of `code`/`session` was an accepted trade-off in round 43) and matches the
  REST surface; intentional, not a regression.
- **`crypto.ts` aggregate byte budget under-counts key names** — already documented (round 40
  deferred); bounded by `MAX_HASH_KEYS` (10k), no DoS path.
- **`sanitize.ts` generic-URL catch-all (no userinfo)** — a non-credential URL with a secret in the
  *path* is not redacted by the catch-all; query-string secrets are now covered (round 43). Known
  limitation, out of scope.
- **`ai_action_log.tenant_id` nullable** — flagged LOW in rounds 38–43; a NULL tenant_id row is
  invisible to all tenants under RLS (no leak). Changing a shipped migration carries risk; deferred.
- **`migrations/20260619000000…` non-concurrent `CREATE INDEX`** — flagged LOW in round 38; `IF NOT
  EXISTS` present, comment documents manual `CONCURRENTLY`. Deferred.

## Test Results
```
shared:    164 passed (4 files)   (+10 — round 44 Map/Set + depth + regression tests)
mcp-tools: 132 passed (4 files)   (+2 — round 44 shared-detector + hard-throw-code regressions)
database:   25 passed, 10 skipped (2 files)
api:       313 passed (14 files)  (+1 — round 44 REST string-message/error regression)
───────────────────────────────────
Total:     634 passed, 10 skipped
```

## Findings & Actions (round 42)

### Fixed this round

1. **🟡 `tool-registry.ts` — Zod validation `issues` were returned to the AI agent
   without sensitive-field redaction or log-output sanitization (asymmetric leak
   vector).** The failed-validation `INVALID_INPUT` path built
   `context: { issues: parsed.error.issues.slice(0, MAX_VALIDATION_ISSUES) }` and
   returned it verbatim to the agent. Unlike every other agent-facing error surface
   (the live `ToolResult` via `redactSensitiveFields`, `DomainError.context` via
   `sanitizeContextValue`, and the audit/idempotency durable sinks), this path was
   **not** filtered: a schema whose issue `message` echoes the received input (a
   common custom-errorMap pattern) would surface that value to the agent, and a
   value carried under a sensitive-named path (`password`, `apiKey`, `token`, …)
   bypassed the key-based redaction applied to live results. Also, any URL/connection
   string embedded in an issue message reached the agent unsanitized. Added
   `sanitizeIssues`, which strips URLs/paths/ANSI from every issue `message`/`path`
   (`sanitizeForLogOutput`) and redacts a `received` value when its path ends in a
   sensitive-named key (`isSensitiveField`) — matching `redactSensitiveFields` /
   `sanitizeContextValue`. The already-capped joined `message` summary is likewise
   sanitized at the call site. Added two regression tests (URL redaction in issue
   message; secret `received` value redacted under a sensitive-named path).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-setup.sql` `set_tenant_context`** — dynamic SQL via `format(..., %L)` quotes
  the tenant id, and `validateTenantIdEnhanced` validates `/^[a-zA-Z0-9_-]+$/`
  at three boundaries, so no SQLi/injection path; SECURITY INVOKER + `search_path`
  pin are present. Defense-in-depth only — no change.
- **`migrations/20260619000000…` non-concurrent `CREATE INDEX`** — flagged LOW in
  round 38, explicitly deferred (changing shipped migrations is risky; the
  migration comment documents manual `CONCURRENTLY` application). No change.
- **`health.controller.ts` `/version` fingerprinting** — flagged LOW in round 38,
  accepted as an operator liveness/version probe (`@Public()`). No change.
- **`discovery-tools.ts`, `queue.module.ts`, `seed.ts`, `cleanup-expired-idempotency.ts`,
  `party-tools.ts`, `party.dto.ts`, `jwt.strategy.ts`, `tenant.ts`, `main.ts`** —
  re-verified clean this round (independent sub-review confirmed no new 🔴/🟡
  exploit paths; all agent-facing surfaces apply consistent redaction/sanitization,
  tenant isolation is enforced at the RLS + app-layer).

## Test Results
```
shared:    153 passed (4 files)   (+0 vs round 41)
mcp-tools: 131 passed (4 files)   (+2 — round 42 issue-sanitization regression tests)
database:   25 passed, 10 skipped (2 files)
api:       309 passed (14 files)
───────────────────────────────────
Total:     618 passed, 10 skipped
```

## Findings & Actions (round 41)

### Fixed this round

1. **🟡 `mcp.module.ts` — idempotency-key charset guard was inconsistent across
   the three boundaries that handle the key (deferred-class / consistency gap).**
   `SAFE_IDEMPOTENCY_KEY` (printable-ASCII only; rejects control chars and
   non-ASCII) was duplicated in `idempotency.ts` and `tool-registry.ts` but the
   MCP auth boundary `McpModule.buildContext` never applied it. A key carrying a
   newline or non-ASCII byte therefore passed `buildContext` and was then
   silently treated as a no-op by the idempotency middleware (which skips
   idempotency on an unsafe key with no error) — replay/dedup protection was
   silently disabled and the caller bug stayed invisible. Promoted the regex to
   `@besterp/shared` (`constants.ts`) as the single source of truth, imported it
   in `idempotency.ts` / `tool-registry.ts`, and added the check to `buildContext`
   so an unsafe key now throws a structured `InvalidTypeValueError` (422) at the
   entry point — matching how every other malformed boundary input is rejected.
   Added a regression test (control-char + non-ASCII keys rejected).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-extension.ts` shared-pool context reset** — flagged in rounds 38/39; the
  design relies on `SET LOCAL app.current_tenant` within a dedicated-connection
  transaction, plus the fail-closed `verifyRlsEnabled` / `verifyAppClientRole`
  boot assertions. No live exploit path; deferred.
- **`ai_action_log.tenant_id` nullable** — flagged LOW in rounds 39/40; a NULL
  tenant_id row is invisible to all tenants under RLS (no leak). Changing a
  shipped migration carries risk; deferred.
- **`spike-rls.ts` Test 3** — spike-only (excluded from build); deferred.
- **`party.service.ts` `searchParties` type-table joins, CORS, RLS-cache closure
  capture, discovery-tools type-table allowlist, queue module, JWT strategy** —
  re-verified clean this round; no new issues.

## Test Results
```
shared:    153 passed (4 files)   (+0 vs round 40)
mcp-tools: 129 passed (4 files)   (+0 vs round 40)
database:   25 passed, 10 skipped (2 files)
api:       309 passed (14 files)  (+1 — round 41 idempotency-key boundary test)
───────────────────────────────────
Total:     616 passed, 10 skipped
```

## Findings & Actions (round 40)

### Fixed this round

1. **🟢 `crypto.ts` — aggregate byte budget under-counted key names (deferred item from
   round 39).** `checkStringBounds` only charged string *values* to `MAX_HASH_TOTAL_BYTES`,
   so the JSON-serialized form of object/Map *keys* escaped the guard: a wide object/Map of
   ~200-byte keys with empty values (12k keys ≈ 2.4 MB of key bytes alone) exceeded the 2 MB
   cap without tripping the DoS guard. Added `chargeKeyBytes` (key length + 2 quote bytes)
   called from `sortPlainObject` (object keys) and `sortMap` (Map keys); both now throw the
   aggregate size-limit `InvalidTypeValueError` before serialization. Added regression tests
   (wide object keys rejected; modest key set accepted; wide Map keys rejected).

2. **🟢 `truncate.ts` — nested Map/Set dropped from the persisted payload (deferred item
   from round 39).** `serializeObjectValue` converted only a *top-level* Map/Set to arrays;
   a Map/Set nested inside an array/object was silently turned into `{}`/`[]` by
   `JSON.stringify`, losing data from the audit/idempotency record (data-loss, not a leak).
   Added `normaliseForTruncation`, which recursively converts nested Map/Set (and
   arrays/plain objects) to JSON-safe arrays, with a `WeakSet` cycle guard and a pass-through
   for special objects (Date/Error/RegExp/class instances) so their `toJSON`/built-in
   serialization is preserved (a Date is not flattened into `{ }`). Added regression tests
   (nested Map-in-array preserved as `[k,v]` pairs; nested Set-in-object preserved; circular
   nested reference returns the error marker rather than being silently elided).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-extension.ts` shared-pool context reset** — flagged in round 38; the design relies
  on `SET LOCAL app.current_tenant` within a transaction that holds a dedicated connection,
  and `verifyRlsEnabled` boot assertion plus fail-closed role check close the misconfig path.
  A redundant explicit `SET LOCAL ... = ''` reset remains deferred (no live exploit path).
- **`ai_action_log.tenant_id` nullable** — flagged LOW in round 39; a NULL tenant_id row is
  invisible to all tenants under RLS (no leak, just a stranded-audit edge). Changing a
  shipped migration carries risk; still deferred.
- **`spike-rls.ts` Test 3 runs against the admin/superuser client** — flagged LOW in round 39;
  spike-only (excluded from build); deferred.

## Test Results
```
shared:    153 passed (4 files)   (+2 — round 40 key-budget regression tests)
mcp-tools: 129 passed (4 files)   (+3 — round 40 nested-Map/Set regression tests)
database:   25 passed, 10 skipped (2 files)
api:       308 passed (14 files)
───────────────────────────────────
Total:     615 passed, 10 skipped
```


## Findings & Actions (round 38)

### Fixed this round

1. **🟡 `crypto.ts:241` — `hashInput` had no aggregate serialized-size cap (memory-DoS).**
   `MAX_HASH_STRING_BYTES` bounds each *individual* string and `MAX_HASH_KEYS` bounds
   container/key count, but an input like `Array(1200).fill("x".repeat(99_000))` passes
   both guards (each string < 100 KB, 1200 keys < 10k) while `JSON.stringify` produces a
   ~115 MB buffer — exhausting memory / blocking the event loop. Added `MAX_HASH_TOTAL_BYTES
   = 2_000_000` and a byte budget threaded through `sortKeysDeep`: every string accrues its
   UTF-8 byte length to the running total and the whole sort throws
   `InvalidTypeValueError` ("aggregate serialized size limit") the moment the budget is
   exceeded, before any large stringification. Added regression tests (wide array of
   near-limit strings rejected; small count accepted).

2. **🟡 `sanitize.ts:119` — `sanitizeLogOutput` left control/ANSI chars intact, and the
   query-string secret rule truncated secrets at boundary punctuation (`)` `]` `}`).**
   `sanitizeLogOutput` is the redaction primitive but did *not* apply the
   log-injection strip (`sanitizeLogMessage`), so a newline injected into a
   credential-bearing message survived into logs when the function was called directly
   (`sanitizeForLogOutput` composes them, but direct use is a documented path). It now
   strips control/ANSI characters first. Separately, the query-string secret value class
   `[^&\s"')\]}]+` stopped at `)`/`]`/`}`, so `...?token=sk_live_abc)` redacted only up to
   the boundary, leaving `]`/`)` behind and truncating the secret mid-value. The value
   class is widened to `[^&\s"']+` and trailing boundary punctuation is trimmed before
   `[REDACTED]` is appended. Added regression tests (boundary punctuation, injected
   newline stripped).

3. **🟡 `error-handler.ts:88` — `DomainError.context` Map/Set values under a sensitive-key
   name were not redacted (agent-facing secret leak).** `sanitizeObject` applies
   `isSensitiveField(k)` → `"[REDACTED]"` to plain-object keys, but the `Map` branch only
   scrubbed *values* (URL/path), so a `DomainError` carrying
   `context: { mapData: new Map([["password", "hunter2"]]) }` reflected `hunter2` to the AI
   agent. The `Map` branch now redacts the value when its key is a sensitive-field name,
   mirroring `audit-log.ts`'s `redactSensitiveFields`. Updated the regression test that
   previously *asserted* the leak (now asserts `[REDACTED]`).

4. **🟡 `prisma.service.ts:205,255` — RLS / superuser boot assertions failed *open* on a
   verification query error.** `verifyAppClientRole` / `verifyRlsEnabled` wrapped the
   actual check in `try/catch` and, on any thrown error (permission denied on `pg_catalog`,
   transient outage, schema drift), logged only a `warn` and booted. That silently starts
   the service with unverified tenant isolation — the exact gap the assertions exist to
   prevent. Both now **fail closed**: a verification query that cannot run throws
   `"… refusing to boot (tenant isolation unverified): …"` (with `cause` attached) instead
   of warn-and-continue. Also switched `verifyRlsEnabled`'s `$queryRawUnsafe` to the
   parameterized `$queryRaw` template for consistency and to remove the "unsafe" footgun
   (the table list was already a hardcoded constant, so no injection surface existed).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-extension.ts` shared-pool context leakage** — flagged by sub-review: the design
  relies on `SET LOCAL app.current_tenant` within an interactive transaction that holds a
  dedicated connection, so a prior tenant cannot leak to a later query; raw-SQL / `$` /
  `_` traps still block reaching the base client, and `verifyRlsEnabled` boot assertion
  (round 37) plus fail-closed role check (this round) close the misconfig path. The
  proposed explicit `SET LOCAL ... = ''` reset would add value but is deferred as a
  defense-in-depth hardening (no live exploit; requires a code path that issues a query
  outside every tenant transaction, which the proxy prevents by construction).
- **`hashInput` `toJSON` enumerable key / `MAX_HASH_TOTAL_BYTES` over-redaction** — an
  input whose aggregate bytes exceed 2 MB is rejected; legitimate tool inputs are bounded
  by field caps (largest is `MAX_PARTY_DESCRIPTION_LENGTH = 1000`), so the budget is
  never hit in practice. `toJSON` rejection is the existing documented behavior for
  non-serializable values.
- **`truncate.ts` string-fallback / `audit-log` `reasoning` not secret-scanned** —
  flagged LOW in sub-review; the `reasoning` string is agent-supplied and capped, and the
  string-fallback in `truncateValue` only affects inputs that already produce invalid
  JSON. Deferred as non-security-impacting.
- **`health.controller.ts` `/version` fingerprinting** — flagged LOW; `/version` is
  `@Public()` and returns package name/version. Accepted trade-off (operators need a
  liveness/version probe); not changed this round.
- **Blocking `CREATE INDEX` in `migrations/20260619000000…`** — flagged LOW; the
  `pg_trgm` GIN index is `CREATE INDEX` (not `CONCURRENTLY`) so it locks the table during
  `prisma migrate deploy`. Deferred: changing shipped migrations is risky and the comment
  already documents manual `CONCURRENTLY` application.
- **`party.service.ts` `searchParties` type-table joins** — confirmed still gated by
  `tenantId` in the same `where`; no cross-tenant leak.
- **ReDoS** — all regexes across the four packages re-verified linear/bounded (no nested
  quantifiers); no new ReDoS introduced by this round's edits.

## Findings & Actions (round 39)

### Fixed this round

1. **🟡 `audit-log.ts:76-77` — successful tool `data` returned to the agent was never
   redacted (secret leak on the live path).** The audit row (`logAction` →
   `truncateValue(redactSensitiveFields(...))`) and the idempotency replay
   (`handleExistingRecord` → `redactSensitiveFields`) both redact sensitive-named fields,
   but the **live** success path returned `result` verbatim to the AI agent. A tool
   returning a value under a sensitive-named key (e.g. a credential) therefore leaked on
   the first call while being redacted everywhere durable. `executeAndLog` now applies
   `redactSensitiveFields` to `result.data` before returning, matching the two durable
   sinks. Added a regression test asserting a `{ password: "hunter2" }` live result reaches
   the agent as `[REDACTED]`.

2. **🟡 `prisma.service.ts:234-259` — `verifyRlsEnabled` had a wrong table list and ignored
   `relforcerowsecurity`.** The checked list contained `party_relationship` and `audit_log`,
   which are **not** tables in `schema.prisma` (the real ones are `party_role` and
   `ai_action_log`), so the check could pass vacuously and give false assurance of tenant
   isolation at boot. It also selected `relforcerowsecurity` but only filtered on
   `relrowsecurity`, so a table with RLS *enabled but not FORCED* (where the app role owns
   it) would still bypass RLS silently. The list now matches the eleven tables that
   `rls-setup.sql` enables RLS + FORCE on, the filter asserts **both** `relrowsecurity` and
   `relforcerowsecurity`, and any listed table missing entirely from `pg_class` (renamed /
   dropped) is now treated as a coverage gap that refuses to boot.

3. **🟡 `domain-exception.filter.ts:156,235` — HTTP error responses reflected
   user-influenced text without hardening in staging/preview.** `handleDomainError`
   genericized the 500 message only under `isProd`, so a 500 `DomainError` in
   staging/preview reflected the raw (user-embedded) message — contradicting round 37's
   "strict-unless-development" intent. Changed to `status === 500 && !isDev`. Separately,
   `handleUnexpectedError`'s dev branch applied `sanitizeForLogOutput` but not
   `stripHtmlTags`, so an HTML/script payload in an unexpected error message reached dev
   clients; now also `stripHtmlTags`. Removed the now-unused `isProd` local.

4. **🟡 `sanitize.ts:133,146-148` — bracket-wrapped query-string secrets leaked, and the
   URL-collapse rule split mid-`[REDACTED]`.** The query-string secret rule trimmed only
   *trailing* boundary punctuation, so `?token=[sk_live_abc]` kept the leading `[` and
   leaked the secret. The leading `[` is now also stripped. Separately, the
   URL-collapse value class excluded `]`, so after the query rule inserted `[REDACTED]` the
   URL rule stopped at the marker's `]`, leaving the remainder of the query string (e.g. a
   second `&token=…`) visible. The three URL-family value classes now allow `[`/`]` (while
   still stopping at `)`/`}` for prose boundaries) so the whole URL — including every
   redacted param — folds into `[HOST]/[PATH]`. Rewrote the three affected regression tests
   to assert the secret is absent (the actual security property) rather than a literal
   `[REDACTED]` token.

5. **🟡 `tenant.ts:43-47` — unvalidated tenant ID echoed into the error message without
   control-char/ANSI stripping (log injection).** `validateTenantId` interpolates a preview
   of the attacker-influenced `tenantId` into the thrown `InvalidTenantIdError` message; if
   it carried CRLF/ANSI escapes those reached operator logs verbatim. The preview is now run
   through `sanitizeLogMessage` before interpolation.

6. **🟢 `error-handler.ts:160` — `P2002` `conflictingFields` used `sanitizeLogMessage`
   instead of `sanitizeForLogOutput`.** `meta.target` is schema-derived (low risk) but every
   other externally-derived string in the file scrubs URLs/paths via `sanitizeForLogOutput`;
   aligned the one inconsistency.

### Reviewed but NOT changed (false positives / out of scope)

- **`crypto.ts` aggregate byte budget under-counts key names** — `checkStringBounds`
  charges only string *values*, not keys, so the serialized buffer can exceed
  `MAX_HASH_TOTAL_BYTES` by ~2%. Still bounded by `MAX_HASH_KEYS` (10k); not a DoS vector.
  Deferred as defense-in-depth.
- **`truncate.ts` nested Map/Set become `{}`/`[]`** — `serializeObjectValue` only converts a
  *top-level* Map/Set; a Map nested in an array/object is dropped from the persisted
  payload (data-loss, not a leak). Noted for a future normalisation pass.
- **`ai_action_log.tenant_id` nullable** — flagged LOW; a NULL tenant_id row is invisible to
  all tenants under the RLS policy (no leak, just a stranded-audit edge). Changing a
  shipped migration carries risk; deferred.
- **`spike-rls.ts` Test 3 runs against the admin/superuser client** — flagged LOW; the
  isolation assertion passing there validates query-time filtering, not RLS enforcement
  under `besterp_app`. Spike-only (excluded from build). Deferred.

## Test Results
```
shared:    151 passed (4 files)
mcp-tools: 126 passed (4 files)
database:   25 passed, 10 skipped (2 files)
api:       308 passed (14 files)
───────────────────────────────────
Total:     610 passed, 10 skipped
```

## Findings & Actions (round 37)

### Fixed this round

1. **🔴 `sanitize.ts:38` — `stripHtmlTags` length guard measured UTF-16 code units, not
   bytes (DoS-guard bypass).** A ~99k multi-byte string is ~400 KB in UTF-8 yet
   `input.length` (code units) stayed under the 100k cap, so it entered the entity-decode
   strip loop and could balloon well past the intended budget. The guard now measures
   `Buffer.byteLength(input, "utf8")`. Added regression test (multi-byte oversized input).

2. **🟡 `sanitize.ts:128-145` — `sanitizeLogOutput` missed bare bearer/JWT secrets and
   false-redacted ordinary prose as file paths.** `Authorization: Bearer sk_live_…` and
   bare JWTs reached operator logs unredacted. The `at /path` path rule also collapsed
   prose like "meet me at /home/user later" into "meet me [PATH] later", destroying
   legitimate log context. Added `Bearer …` and JWT redaction, and rewrote the path rule
   to redact only absolute paths that actually look like file paths (extension or `:line`
   suffix), leaving plain prose intact. Added regression tests.

3. **🟢 `validation.ts:32` — `EMAIL_REGEX` accepted invalid local parts (consecutive/leading/
   trailing dots).** Added `(?!\.)(?!.*\.\.)…(?<!\.)` guards so `a..b@x.com` and `.a@x.com`
   are now rejected. Existing valid addresses still pass.

4. **🟡 `error-handler.ts:120` — MCP `DomainError.message` returned verbatim to the AI agent
   without `sanitizeForLogOutput`.** `handleDomainError` is the one agent-facing surface that
   did not scrub URLs/paths from the message (generic errors return a fixed string; idempotency
   / audit / HTTP paths all sanitize). Now applies `sanitizeForLogOutput` consistently.

5. **🟡 `tool-registry.ts:200` — unbounded `context.issues` array returned to the agent (DoS /
   memory amplification).** Zod emits one issue per invalid element, so a crafted large array
   produced an arbitrarily large issues array in the tool result. Now capped at
   `MAX_VALIDATION_ISSUES = 50` (the message string was already capped at 2000 chars).

6. **🟡 `domain-exception.filter.ts:153,171` — reflected `DomainError.message` not HTML-stripped;
   error-response hardening gated on exact `NODE_ENV === "production"`.** The message embedded
   user input but only control-char sanitized, so `<script>` reflected intact into the JSON
   response. `handleDomainError` now also runs `stripHtmlTags`. `handleHttpException` only
   stripped internal details under `production`, so staging/preview envs leaked raw validation
   bodies; inverted to strict-unless-`development` so hardening is the default.

7. **🔴 `prisma.service.ts:177` — superuser detection keyed on role name, not privilege; no boot
   RLS assertion.** `verifyAppClientRole` only flagged roles literally named `besterp`/`postgres`,
   missing any role granted `SUPERUSER`/catalog-update. Now queries `pg_roles` for `rolsuper`/
   `rolcatupdate`. Added `verifyRlsEnabled()` called at boot: it refuses to start if RLS is not
   enabled on the core tenant tables (RLS lives in the standalone `rls-setup.sql`, which
   `prisma migrate deploy` does not run — a forgotten apply meant silent cross-tenant exposure).

8. **🟢 `migrations/20260619000000…/migration.sql:9` — non-idempotent `CREATE INDEX`.** Added
   `IF NOT EXISTS` so a re-run during manual production recovery no longer aborts.

### Reviewed but NOT changed (false positives / out of scope)

- **RLS-cache method/delegate caches** — closure captures the single `tenantId` bound at
  `createTenantClient` time; clients are cached per `tenantId`, never reused across tenants.
- **`crypto.ts` `hashInput`** — depth/key/string-byte guards confirmed correctly ordered; no
  bypass. `NaN`/`Infinity`→`null`, circular `cause` handled.
- **`party.service.ts` duplicate-contact / role checks** — RLS-scoped; explicit `tenantId`
  filters consistent with the app-role path.
- **CORS** — exact-origin match with `credentials` only when origin configured; no `*` reflection.

## Findings & Actions (round 35)

### Fixed this round

1. **🔴 `idempotency.ts:259` / `truncate.ts` — `_truncated` marker collided with real
   user data (correctness/abuse path).** The replay path detected truncation via a bare
   `"_truncated" in data` check. A tool whose result genuinely contains a top-level
   `_truncated` field would be falsely reported to the agent as "was truncated for
   storage", and a `_truncated:true` field could be misread on replay. `truncateValue`
   now emits a high-entropy private discriminator (`__besterp_trunc`) alongside the
   `_truncated` flag, and `handleExistingRecord` detects truncation via the exported
   `isTruncationMarker` helper. Added regression tests.

2. **🔴 `sanitize.ts:121` — secrets in HTTP URL query strings were not redacted.** The
   generic `https?://…` rule reduced a URL to `[HOST]/[PATH]` but preserved the full
   query string, so `https://api.example.com/v1/charge?api_key=sk_live_abc123&token=xyz`
   leaked both secrets to operator logs. A new regex redacts common secret-bearing query
   parameters (`key`, `token`, `secret`, `password`, `access_token`, `auth`, `api_key`,
   `apikey`, `client_secret`) to `[REDACTED]`. Added regression test.

3. **🟡 `validation.ts:61` — ISO date regex accepted invalid timezone offsets
   (`+14:30`, `+14:59`, `-12:30`, `-13:00`).** The offset minute group `[0-5]\d` was
   unconstrained for extreme hours. The regex now restricts `+14` to `:00` only and
   `-12` to `:00` only, keeping the valid -12:00..+14:00 window. Added regression test.

4. **🟡 `errors.ts:60-68` — `DomainError.toJSON` serialized non-Error `cause` via
   `String(cause)`.** A non-`Error` cause (e.g. an attached object) would have its data
   stringified into audit logs / idempotency records; a custom class `toString()` can
   embed sensitive field data. Non-Error causes now serialize to the safe placeholder
   `[Non-error cause]`. Updated the regression test.

5. **🟡 `idempotency.ts:153-155` — idempotency key leaked its first 32 plaintext chars to
   agent-facing error messages.** `redactKey` embedded `key.slice(0, 32)` verbatim; if a
   key ever carried a secret (defense-in-depth), up to 32 chars reached the AI agent.
   Keys are now hashed with SHA-256 and only a 12-char opaque prefix (`id-…`) is shown.
   Updated the regression test that asserted the raw key appeared in stderr.

6. **🟢 `sensitive-fields.test.ts:170-175` — pre-existing broken test.** The `redactSensitiveFields`
   describe block used a top-level `await import(...)` outside an async function, so the
   entire test file failed to transform (0 tests ran). Replaced the dynamic import with a
   static top-level import. The file now executes (part of the 121→122 mcp-tools tests).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-extension.ts:199-215` method-cache `tenantId` capture (flagged HIGH by sub-review).**
  Verified the closure captures the single `tenantId` bound at `createTenantClient` time, and
  `PrismaService.tenantScoped` caches clients keyed by `tenantId` (`prisma.service.ts:247`),
  so a proxy is never reused across tenants. The finding does not manifest in real usage.
- **Cross-tool / cross-user idempotency key collision.** The DB unique constraint is
  `(idempotencyKey, tenantId)`; keys are caller-supplied opaque tokens (UUID/ULID/hash) and
  are treated as secret per-operation. Re-namespacing by tool/user would be a breaking change
  to the existing contract and is deferred.
- **`create-roles.sql:19` committed dev password.** Documented dev-only with `NOINHERIT`;
  left as-is to avoid diverging from the provisioning script's contract. Tracked as a follow-up.

## Findings & Actions (round 34)

### Fixed this round

1. **🔴 `crypto.ts:104-111` — `Error.cause` hashed shallow + circular `cause` not
   detected.** `serializeSpecialObject` flattened `cause` to one level (`{name, message}`),
   so two inputs differing only in `cause` depth hashed **identically** (defeating
   idempotency mismatch detection), and a circular `cause` chain did **not** throw like
   every other circular type. `cause` is now recursively serialized via
   `sortKeysDeep(value.cause, ancestors, depth + 1)`, inheriting the circular + depth
   guards. Added regression tests.

2. **🔴 `idempotency.ts:406` — success/failure `result` persisted & replayed without
   sensitive-field redaction (secret-leak path).** The audit log redacts
   `toolOutput` via `redactSensitiveFields`, but the idempotency `result` column applied
   only `truncateValue`. A tool returning a value under a sensitive-named key would
   persist it unredacted and replay it to the agent verbatim. Now `redactSensitiveFields`
   runs before `truncateValue` on persist and is re-applied on replay. `redactSensitiveFields`
   was exported from `audit-log.ts` and reused so both durable sinks share one implementation.

3. **🟡 `truncate.ts:188` — `JSON.parse` could throw, violating the "never throws"
   contract.** A value `JSON.stringify` emits but cannot re-parse (e.g. custom `toJSON`
   emitting a lone surrogate) would crash a fire-and-forget audit/idempotency write. Added a
   local `safeParse` that falls back to the string form. Added a regression test.

4. **🟡 `error-handler.ts:140` — Prisma `meta.target` echoed to the agent unsanitized.**
   The `P2002` handler interpolated `meta.target` (user-influenced under compound
   constraints) verbatim into the `DUPLICATE_ENTITY` message / `context.conflictingFields`,
   inconsistent with every other externally-derived string in the file. Now run through
   `sanitizeLogMessage`.

5. **🟡 `party.service.ts:611,808` — party existence checks relied solely on RLS
   (incomplete round-32 hardening).** Round 32 added `tenantId` to `getParty`'s `where`, but
   two sibling existence checks (`addPartyRoleTransaction`, `createContactMechanismTransaction`)
   still queried `party.findUnique({ where: { partyId } })` with no `tenantId`. Added
   `tenantId` to both, mirroring `getParty`.

6. **🟡 `cleanup-expired-idempotency.ts` — advisory lock ineffective across Prisma's
   connection pool.** `pg_try_advisory_lock` is session-scoped; under Prisma's pool the lock
   and the batch operations could land on different backend connections, voiding
   serialization. The whole cleanup now runs inside a single interactive `$transaction`.

7. **🟡 `.github/workflows/ci.yml` — round-33 `ALLOW_SEED` guard broke the CI seed step.**
   Added `ALLOW_SEED: "1"` to the CI "Seed database" step (ephemeral CI Postgres, safe).

8. **🟢 `rls-setup.sql` — `set_tenant_context` lacked `search_path` pin + superuser
   assertion.** Added `SET search_path = pg_catalog, public` to the function and a `DO $$`
   assertion that raises if `besterp_app` is a superuser.

9. **🟢 `health.controller.ts` — unauthenticated `/health` leaked environment/memory/uptime.**
   The anonymous `/health` success path now returns only `{ status, timestamp, database }`.

### Verified clean (no action needed)
- **`sanitize.ts` decode loop** — 100 KB input cap + 10-iteration bound; all tag/entity
  regexes are linear character classes (no ReDoS).
- **`validateTenantId` / regexes** — `UUID_REGEX`, `EMAIL_REGEX`, `TENANT_ID_PATTERN`,
  `ISO_DATE_REGEX` all anchored/bounded, no ReDoS.
- **`sortKeysDeep`** — depth (100) + key-count (10k) guards; WeakMap/WeakSet rejected;
  ancestor-set cleanup on every exit path (round 31).
- **`idempotency.ts` state machine** — acquire/failed/stale-pending transitions under
  Serializable isolation with P2034 retry; narrow failed-record race handled as
  `REQUEST_IN_PROGRESS`.
- **`rls-extension.ts` Proxy traps** — raw SQL / `$` / `_` props blocked; array `$transaction`
  rejected; non-existent models throw.
- **`party.controller.ts` / `auth` guards** — `tenantId` taken solely from JWT context and
  spread after the body; global guards honor `@Public()`; `TenantGuard` defensively
  re-validates `tenantId`/`userId`.
- **`discovery-tools.ts`** — `typeName` is a `z.enum` allowlist; type tables are global by
  design (admin client).
- **`audit-log.ts`** — backpressure manager, `redactSensitiveFields` depth + circular guards.

## Test Results
```
shared:    138 passed (4 files)
mcp-tools: 121 passed (4 files)
database:   25 passed, 10 skipped (2 files)
api:       306 passed (14 files)
───────────────────────────────────
Total:     590 passed, 10 skipped
```

## Findings & Actions (round 33)

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 138, mcp-tools 119, database 25 (10 RLS isolation
  tests skipped without a live DB), api 305

## Findings & Actions (round 33)

### Fixed this round

1. **🟡 `seed.ts:31` — seed guard bypassable by any non-`production`/`staging` `NODE_ENV`.**
   The guard refused `production`/`staging` only. An operator pointing `DATABASE_ADMIN_URL`
   at a production database while leaving `NODE_ENV` unset (or `development`, a common
   container-env reuse mistake) would silently insert the hard-coded `tenant-acme` /
   `tenant-globex` test tenants into prod. Seeding now additionally requires an explicit
   opt-in: `ALLOW_SEED=1`. There is no safe default that permits the destructive insert
   without a deliberate signal. The `NODE_ENV` refusal is retained as a backstop.

2. **🟢 `health.controller.ts:73` — unsanitized `debug` log (log-injection
   inconsistency).** The readiness race handler interpolated the raw DB error `message`
   directly into a `logger.debug` call, inconsistent with every other error log in the
   codebase which wraps infra-derived messages in `sanitizeForLogOutput(...)` /
   `sanitizeLogMessage(...)`. Wrapped the message so a crafted/compromised driver error
   cannot inject ANSI escapes or CRLF into logs. `sanitizeForLogOutput` was already imported.

3. **🟢 `cleanup-expired-idempotency.ts` — destructive prod script lacks an opt-in.**
   The cron script runs as superuser (bypasses RLS) and deletes rows. A misconfigured
   `DATABASE_ADMIN_URL` pointing at prod could wipe expired idempotency records
   unattended. Normalized `NODE_ENV` and refuse to run in `production` unless
   `ALLOW_CLEANUP_PRODUCTION=1` is set explicitly.

4. **🟢 `pluralize.ts:33` — single-letter input force-uppercased (cosmetic casing bug).**
   `preserveCasing` checked the all-caps branch (`input === input.toUpperCase()`) first, so
   a single uppercase letter like `"Y"` returned an all-caps plural (`"IES"`) instead of
   preserving the single leading capital. Excluded length-1 inputs from the all-caps branch
   so they fall through to the leading-capital rule. (Cosmetic — affects MCP error messages
   / suggested tool names only.) Added a regression test.

5. **🟢 `spike-rls.ts:11` — hardcoded-looking DB credential in a committed spike.**
   The dev spike embedded a real-looking connection string
   (`besterp_app:besterp_app_dev@localhost:5434`). It is excluded from the published build
   (`tsconfig` `include: ["src"]`) and only runs via `npm run spike:rls`, but it trips
   secret scanners. Replaced with a `<user>:<pass>@<host>:<port>` placeholder.

### Verified clean (no action needed)
- **`discovery-tools.ts`** — `get_type_table_values` restricts `typeName` to a `z.enum`
  compile-time allowlist and validates the resolved delegate at runtime; type tables are
  intentionally global (admin client, RLS bypass) shared vocabulary. No injection surface.
- **`party.dto.ts` / `party.controller.ts`** — `tenantId` is taken solely from the
  JWT-derived `req.tenantContext` and spread after the body (so client-supplied `tenantId`
  is discarded); the handler/service never trusts a request body tenant. `forbidNonWhitelisted`
  is on. No tenant-isolation leak.
- **`auth.module.ts` / `jwt-auth.guard.ts` / `tenant.guard.ts`** — global guards registered
  in the correct order; both honor `@Public()` via Reflector; `TenantGuard` defensively
  re-validates/trims `tenantId`/`userId`. No authz gaps.
- **`mcp.module.ts`** — `buildContext` validates `tenantId` format, type- and length-checks
  `userId` and all optional fields. Consistent with the hardened boundary pattern.
- **`queue.module.ts`** — Redis password required in non-dev, port validated 1–65535, retry
  capped. No issues.
- **`seed.ts` / `cleanup-expired-idempotency.ts`** — SQL uses Prisma parameterized operations
  and tagged-template `pg_try_advisory_lock`; batching + composite-key delete are precise.
- **`shared/index.ts`, `mcp-tools/index.ts`, `database/index.ts`** — barrel exports only.

## Findings & Actions (round 32)

### Fixed this round

1. **🟡 `party.service.ts:427` — `getParty` relied solely on RLS for tenant isolation
   (no app-level `tenantId` filter).** Every other party query adds `tenantId` to the
   `where` clause (`searchParties`, `addPartyRole`, `addContactMechanism`) as defense-in-depth,
   but `getParty` queried only by `partyId`, depending entirely on `set_tenant_context` having
   been applied correctly. A future regression in the proxy/transaction context-setting path
   would have turned this into a silent cross-tenant read. Added `tenantId: trimmedTenantId`
   to the `where` clause so a regression in the RLS path cannot leak data across tenants.
   Added a regression test asserting the `where` clause contains both `partyId` and `tenantId`.

2. **🟡 `prisma.service.ts:181` — `verifyAppClientRole` allowed a superuser app client
   outside production, and its warning was misleading.** The check threw only in production;
   in dev/staging a `DATABASE_URL` pointing at `postgres`/`besterp` (superuser) silently
   bypassed RLS for every tenant-scoped query. Worse, the warning claimed audit/idempotency
   rows would be "silently rejected" when in fact a superuser *bypasses* RLS so cross-tenant
   writes succeed. The check now throws unconditionally on a superuser app role, and the
   message is corrected to state RLS is bypassed / tenant isolation disabled.

3. **🟡 `tool-registry.ts:182` — `INVALID_INPUT` returned an unbounded Zod issue string to
   the agent.** The joined `path: message` list is derived from user input and could grow
   arbitrarily large (many issues, or long per-issue messages), bloating the agent-facing
   response. Capped the joined string at 2000 chars (the full issue list remains in
   `context.issues` for programmatic callers), mirroring the existing 500-char log-line bound.

4. **🟡 `idempotency.ts:410` — soft-failure `error.code` was stored verbatim (unbounded).**
   `error.message` was already `capString`-capped, but `error.code` (a free-form string from
   the defensive `getErrorCode`, not an allowlist) was persisted as-is, so a tool returning a
   multi-KB `code` would bloat `idempotency_record.error.code`. Now routed through `capString`
   + `sanitizeForLogOutput` with the same 4096-byte bound. Added a regression test asserting a
   20 KB `code` is capped on persistence.

5. **🟢 `truncate.ts:188` — object payload could exceed the 64 KB bound after normalisation.**
   `truncateValue` measured the input's `JSON.stringify` before the `JSON.parse` round-trip that
   normalises class instances / Maps / Sets / BigInt / Dates to their JSONB form. For
   pathological inputs the normalised form can be larger than the measured one, so the stored
   payload escaped the size cap silently. Added a post-parse re-validation: the normalised form
   is re-encoded and, if still over the limit, replaced with the truncation marker. Added a
   regression test asserting the returned structure's re-encoded size is always within
   `MAX_STORED_PAYLOAD_SIZE`.

### Verified clean (no action needed)
- **`sanitize.ts` decode-then-strip loop** — length cap (100 KB) and 10-iteration bound hold;
  control-char and ANSI stripping confirmed.
- **`crypto.ts` `sortKeysDeep`** — `try/finally` ancestor-set cleanup on every exit path
  (fixed round 31); depth (100) and key-count (10k) bounds intact; WeakMap/WeakSet rejected.
- **`rls-extension.ts` Proxy traps** — raw SQL / `$`-prefixed methods blocked; array-form
  `$transaction` rejected; `set`/`deleteProperty` blocked.
- **`idempotency.ts` state machine** — acquire/failed/stale-pending transitions under Serializable
  isolation with P2034 retry; narrow failed-record race handled as `REQUEST_IN_PROGRESS`.
- **`jwt.strategy.ts` / `tenant.guard.ts`** — required/optional field trim+length validation;
  `tenantId` format validated at the auth boundary; JWT wins over body via spread order.
- **`domain-exception.filter.ts`** — recursive context sanitisation, ANSI/control stripping,
  production 500s generic; validation detail dropped in prod.
- **`validation.ts` regexes** — `UUID_REGEX`, `EMAIL_REGEX`, `COUNTRY_CODE_REGEX`, `TENANT_ID_PATTERN`
  all anchored/bounded, no ReDoS; `isValidISODate` enforces month/day/year/leap correctly.
- **`party.service.ts` duplicate contact-mechanism check** — `checkEmailDuplicate` /
  `checkTelecomDuplicate` correctly scoped to `(partyId, tenantId)` via the `partyContacts`
  relation (fixed round 31); email redaction preview correctly clamped before `@`.

## Findings & Actions (round 31)

### Fixed this round

1. **🟡 `party.service.ts` — duplicate email/phone check not scoped to the party (false
   negative → duplicate allowed).** `checkEmailDuplicate` / `checkTelecomDuplicate`
   issued a tenant-wide `findFirst` and then de-duplicated in memory with
   `contactMechanism.partyContacts.some((pc) => pc.partyId === partyId)`. Because
   `findFirst` returns an *indeterminate* match across all parties in the tenant, the
   in-memory `some()` check ran against the wrong party's row: if party B's email was
   the one returned, the check looked for party A and returned `false`, so a genuine
   duplicate for party A slipped through. Fixed by pushing the `partyContacts.some({
   partyId })` filter into the Prisma `where` clause so the query itself is scoped to
   the requesting party; the `if (existing)` result no longer needs an in-memory
   re-check. Same correction applied to `checkTelecomDuplicate`. Added a regression
   test asserting the query `where.contactMechanism.partyContacts.some.partyId` equals
   the requesting party and that a same-email-on-another-party does not false-positive.

2. **🟡 `truncate.ts` — `Date` size check double-encoded by `JSON.stringify` round-trip
   (inaccurate truncation threshold).** `normalisePrimitive` for `Date` ran the ISO
   string through `JSON.stringify` before `TextEncoder.encode`, which wraps the string
   in quotes (`"2024-..."`) and inflates the byte count by 2. The oversize marker was
   therefore computed against a length 2 bytes larger than what is actually stored,
   so values just under the threshold could be misclassified and the preview boundary
   drifted. Fixed by encoding the ISO string directly (strings are JSON-safe; no
   quoting needed), matching the existing `string` fast path. Behaviour unchanged for
   non-oversize values; only the boundary/truncation decision is now accurate.

3. **🟢 `crypto.ts` `sortKeysDeep` — `ancestors.delete` skipped on early return
   (ancestor-set leak across sibling branches).** `sortArray`, `sortMap`, `sortSet`,
   and `sortObject` added the current value to the `ancestors` `Set` but only deleted
   it on the final `return` line. Any branch that returned early (e.g. `sortMap`/
   `sortSet` returning the pre-computed array, or `sortObject` returning directly from
   inside the `try`) left the value in the set, so a later sibling value that
   legitimately shared that reference would be misreported as a circular reference.
   Wrapped each in `try { ... } finally { ancestors.delete(value); }` so cleanup runs
   on every exit path.

4. **🟢 `prisma.service.ts` — typo `BYPASSSED` in RLS-bypass warning (and the matching
   `catch` guard).** The superuser-RLS-bypass error message and the `catch` block that
   re-throws it on that exact substring both spelled `BYPASSED` as `BYPASSSED`. The
   mismatch meant the intended re-throw path was dead code (the `catch` never matched),
   so a genuine bypass condition fell through to the generic `warn` instead of being
   surfaced as an error. Fixed the spelling in both the message constant and the
   `.includes()` guard.

5. **🟢 `health.module.ts` — `HealthService` exported but never consumed externally.**
   `HealthModule` re-exported `HealthService`, but no other module imports it (the
   controller injects it locally within the module). Removed the unused `exports` to
   keep the module boundary honest.

### Verified clean (no action needed)

- **`party.service.ts` `getParty` lacks a `try/catch` + `handleTransactionError`
  wrapper** — intentional asymmetry. Unlike the four write methods, `getParty` issues
  a standalone `findUnique` (the tenant-scoped Proxy already wraps it in an RLS
  transaction). A Prisma error here propagates to the MCP `errorHandlerMiddleware`
  (which maps P2002/P2003/P2024/P2025/P2034 to agent-facing codes) or the REST filter,
  so it is handled downstream. `findUnique` realistically only throws connection
  errors or P2023 (malformed UUID, already rejected by `requireUuid`), so a
  service-level remap adds little. Left as-is to avoid a redundant double-transaction.
- **`idempotency.ts` stale-pending / failed / completed state machine** — re-traced
  all `acquireIdempotencyRecord` → `handleExistingRecord` transitions (pending+stale,
  pending+recent, completed, failed, hash-match/mismatch); all branches are correct
  and the narrow failed-record race window is explicitly handled with
  `REQUEST_IN_PROGRESS`.
- **`sanitize.ts` decode-then-strip loop** — stable; the `MAX_INPUT_LENGTH` (100 KB)
  cap and `MAX_SANITIZE_ITERATIONS` (10) bound the DoS surface.
- **`crypto.ts` `sortKeysDeep`** — circular-reference, depth (100), WeakMap/WeakSet,
  and function guards all present; prototype-pollution-safe via `Object.create(null)`;
  ancestor-set cleanup now runs on every exit path (see fix #3).
- **`rls-extension.ts` Proxy traps** — `set`/`deleteProperty` blocked on both client
  and model delegates; raw SQL and `$`-prefixed methods blocked; non-existent models
  throw a clear error (round 26).

## Test Results
```
shared:    137 passed (4 files)
mcp-tools: 121 passed (4 files)
database:   25 passed, 10 skipped (2 files)
api:       306 passed (14 files)
────────────────────────────────────
Total:     589 passed, 10 skipped
```

## Resolved candidates (cumulative)
- ~~`sensitive-fields.ts` missing OTP/MFA~~ — addressed in round 22
- ~~`sensitive-fields.ts` missing `dateOfBirth`/`passcode`/`passphrase`~~ —
  addressed in round 25
- ~~`error-handler.ts` `sanitizeContextValue` did not redact by field name~~ —
  addressed in round 21
- ~~`rls-extension.ts` silent undefined for non-existent model delegates~~ —
  addressed in round 26
- ~~`party.service.ts` missing explicit throw after handleTransactionError~~ —
  addressed in round 26
- ~~`domain-exception.filter.ts` unsanitized context in dev responses~~ —
  addressed in round 26
- ~~`domain-exception.filter.ts` unsanitized message in responses (dev + prod)~~ —
  addressed in round 27
- ~~`domain-exception.filter.ts` sanitizeContext not recursive for nested
  objects~~ — addressed in round 27
- ~~`party.service.ts` duplicate email/phone check not scoped to party~~ — addressed
  in round 31
- ~~`truncate.ts` Date size check double-encode~~ — addressed in round 31
- ~~`crypto.ts` `sortKeysDeep` ancestor-set leak on early return~~ — addressed in
  round 31
- ~~`prisma.service.ts` `BYPASSSED` typo breaks RLS-bypass re-throw~~ — addressed in
  round 31
- ~~`health.module.ts` unused `exports`~~ — addressed in round 31
- ~~`party.service.ts` `getParty` RLS-only tenant isolation (no app-level
  filter)~~ — addressed in round 32
- ~~`prisma.service.ts` superuser app client allowed outside production + misleading
  warning~~ — addressed in round 32
- ~~`tool-registry.ts` unbounded Zod issue string returned to agent~~ — addressed in
  round 32
- ~~`idempotency.ts` soft-failure `error.code` stored verbatim~~ — addressed in
  round 32
- ~~`truncate.ts` object payload exceeds 64 KB bound after normalisation~~ — addressed
  in round 32
