// Shared validation constants for BestERP.
//
// Centralises validation patterns used across packages to avoid
// duplication and ensure consistency.

import { InvalidTypeValueError } from "./errors.js";
import { MAX_USER_ID_LENGTH, MAX_DATE_STRING_LENGTH } from "./constants.js";
import { sanitizeForLogOutput } from "./sanitize.js";

/**
 * Permissive identity pattern for user IDs and agent IDs.
 *
 * More permissive than TENANT_ID_PATTERN (which is strict: alphanum + hyphen + underscore)
 * because user IDs and agent IDs may contain dots, plus signs, and other characters
 * valid in real systems (e.g. "john.doe", "user+admin"). Rejects whitespace, control
 * characters, and zero-width/bidi sequences that could confuse downstream sanitization
 * or make two visually-identical IDs hash to different idempotency composite keys.
 *
 * Used by:
 * - JwtStrategy.validate() for userId pattern checks
 * - TenantGuard for the agentId pattern check
 * - McpService.buildContext() / ToolRegistry.validateContextIdentity() for
 *   userId/agentId/conversationId pattern checks
 */
export const OPTIONAL_ID_PATTERN: RegExp = new RegExp(`^[^\\s\\x00-\\x1f\\x7f-\\x9f\\u00ad\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]{1,${MAX_USER_ID_LENGTH}}$`);

/**
 * Validate an optional identity string against {@link OPTIONAL_ID_PATTERN}.
 *
 * Use this INSTEAD of calling `OPTIONAL_ID_PATTERN.test(value)` directly:
 * `RegExp.prototype.test` coerces its argument to a string, so
 * `OPTIONAL_ID_PATTERN.test(undefined)` evaluates the literal string
 * `"undefined"` — which MATCHES the pattern. A non-string value would
 * therefore be silently accepted by a bare `.test()` call.
 *
 * @returns true when `value` is a string that satisfies the pattern.
 */
export function isValidOptionalId(value: unknown): value is string {
  return typeof value === "string" && OPTIONAL_ID_PATTERN.test(value);
}

/**
 * Trim and validate an optional string field, throwing on non-string /
 * whitespace-only / over-length input. Returns undefined for null/undefined.
 *
 * Throws InvalidTypeValueError (not a plain Error) so callers receive a
 * structured domain error with code, suggested tools, and context — the same
 * shape every other validation surface in the codebase produces. Importing
 * from ./errors.js is safe: validation.ts has no dependents in errors.ts,
 * so there is no circular dependency.
 */
export function validateOptionalString(
  fieldName: string,
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InvalidTypeValueError(
      `'${fieldName}' must be a string.`,
      { context: { field: fieldName, received: typeof value } }
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (value.length > 0) {
      throw new InvalidTypeValueError(
        `'${fieldName}' cannot be whitespace-only.`,
        { context: { field: fieldName } }
      );
    }
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new InvalidTypeValueError(
      `'${fieldName}' exceeds maximum length of ${maxLength} characters.`,
      { context: { field: fieldName, length: trimmed.length } }
    );
  }
  return trimmed;
}

/**
 * UUID validation regex — matches standard hyphenated UUID format.
 *
 * Accepts `550e8400-e29b-41d4-a716-446655440000` (8-4-4-4-12 with hyphens).
 * Rejects malformed UUIDs with hyphens in wrong positions.
 *
 * Used by:
 * - Zod schemas in party-tools.ts
 * - PartyService.requireUuid()
 * - PartyController.requireUuid()
 */
export const UUID_REGEX: RegExp =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Pragmatic email validation regex — accepts the vast majority of real-world
 * addresses while rejecting obvious garbage (missing `@`, missing domain,
 * embedded whitespace, missing TLD, numeric-only TLD). Intentionally NOT RFC
 * 5322-compliant: strict compliance produces a regex thousands of characters
 * long and still rejects addresses that are valid in practice (e.g.
 * `user+tag@example.com`).
 *
 * The final TLD segment is strictly alpha (`[a-zA-Z]{2,63}`): numeric or
 * digit-containing TLDs like `example.123` / `example.c0m` never exist in
 * practice and are rejected, matching the rejection behavior of Zod's
 * `.email()` and class-validator's `@IsEmail` so all three surfaces agree.
 * Hyphens are excluded from the TLD: the previous optional
 * `(?:[a-zA-Z-]{0,61}[a-zA-Z])?` tail admitted non-existent hyphenated TLDs
 * (`example.co-m`) while still rejecting the only legitimate hyphen+digit
 * TLD family (punycode `xn--*`) — simultaneously too lax and too strict.
 *
 * Used by:
 * - PartyService.addContactMechanism (email type)
 * - Zod schemas in party-tools.ts (via .email() — kept aligned by tests)
 * - DTOs in party.dto.ts (via class-validator's @IsEmail — kept aligned by tests)
 */
export const EMAIL_REGEX: RegExp = /^(?!\.)(?!.*\.\.)[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(?<!\.)@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,63}$/;

/**
 * E.164 country code validation — `+` followed by 1 to 3 digits, first digit
 * non-zero. Rejects obviously invalid codes like +0 or +01, and (since these
 * values are stored/formatted, not used for routing) accepts the full 1–3 digit
 * range including some non-assigned codes (e.g. +999). Callers that need strict
 * validation against the real +1…+998 E.164 range should use an allow-list.
 *
 * Used by PartyService.addContactMechanism (telecom type).
 */
export const COUNTRY_CODE_REGEX: RegExp = /^\+[1-9]\d{0,2}$/;

/**
 * ISO 3166-1 alpha-2/alpha-3 country code — exactly 2 or 3 ASCII letters.
 * Apply AFTER trim+uppercase. The length-only checks previously used by all
 * three layers (REST DTO, MCP Zod, service) admitted garbage like "1A" or
 * "++" despite every layer documenting "ISO 3166-1 alpha-2/3".
 *
 * Used by PartyService.addContactMechanism (postal type) and both boundary
 * schemas for the postal country field.
 */
export const COUNTRY_CODE_ISO_REGEX: RegExp = /^[A-Z]{2,3}$/;

/**
 * ISO 8601 date validation regex.
 *
 * Accepts:
 * - `2024-06-15` (date-only)
 * - `2024-06-15Z` (date-only with UTC marker; V8 parses this as UTC midnight —
 *   accepted for backwards compatibility with the documented contract)
 * - `2024-06-15T00:00:00` (naive datetime — parsed as UTC, see
 *   normalizeISODateTimeToUTC)
 * - `2024-06-15T00:00:00.000Z` (UTC with milliseconds)
 * - `2024-06-15T00:00:00+01:00` (with timezone offset)
 *
 * Enforces valid calendar ranges:
 * - Month: 01-12
 * - Day: 01-31 (month-specific limits enforced by isValidISODate at runtime)
 *
 * Used by:
 * - Zod schemas in party-tools.ts (birthDate, registrationDate, fromDate)
 * - PartyService.requireValidDate()
 */
export const ISO_DATE_REGEX: RegExp =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(Z|T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|\+14:00|-12:00|\+(0\d|1[0-3]):[0-5]\d|-(0\d|1[0-1]):[0-5]\d)?)?$/;

/**
 * Normalize an ISO 8601 string so date-only and naive-datetime forms mean
 * the same instant regardless of the host timezone.
 *
 * Per ES spec, `new Date("2024-06-15")` is UTC midnight, but
 * `new Date("2024-06-15T00:00:00")` (no offset) is LOCAL midnight — two
 * semantically identical inputs resolve to different instants on any non-UTC
 * host, silently shifting stored dates (birth dates, role from-dates) by a
 * day. Appending `Z` to the naive form makes every accepted form resolve
 * identically.
 */
export function normalizeISODateTimeToUTC(value: string): string {
  // Has a time component but no offset/Z suffix → treat as UTC.
  if (/T[0-9:]/.test(value) && !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return `${value}Z`;
  }
  return value;
}

/**
 * Parse an ISO 8601 date string to a Date with timezone-independent
 * semantics (see normalizeISODateTimeToUTC). Use this instead of
 * `new Date(value)` for any user-supplied date so storage does not depend
 * on the server's timezone.
 *
 * Belt-and-suspenders NaN guard: callers are expected to validate the input
 * via isValidISODate before invoking this function, but the guard catches
 * misbehaving callers (or future regression) so an invalid Date cannot leak
 * into storage or downstream logic.
 *
 * Throws a structured `InvalidTypeValueError` (not a plain Error) so the REST
 * filter and the MCP error-handler report an actionable client error (422 /
 * INVALID_TYPE_VALUE) instead of an opaque 500 INTERNAL_ERROR. The offending
 * value is NOT echoed back — it is user-supplied and may carry a secret; the
 * sanitized value is carried in the error context instead.
 */
export function parseISODateTimeAsUTC(value: string): Date {
  const date = new Date(normalizeISODateTimeToUTC(value));
  if (Number.isNaN(date.getTime())) {
    throw new InvalidTypeValueError("Invalid ISO date string.", {
      context: { received: sanitizeForLogOutput(value).slice(0, MAX_DATE_STRING_LENGTH) },
    });
  }
  return date;
}

/**
 * Days in each month. Index 0 is unused; month 1 = January.
 * February is set to 29; a separate leap-year check catches non-leap Feb 29.
 */
const DAYS_IN_MONTH = Object.freeze([0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/**
 * Validate that a string is a parseable ISO 8601 date.
 * Combines regex validation with Date.parse() for defense-in-depth.
 * Also enforces month-specific day limits (e.g. Feb 30 is rejected).
 */
export function isValidISODate(value: string): boolean {
  // Parse the UTC-normalized form so the validity verdict is computed on the
  // same instant callers store via parseISODateTimeAsUTC.
  //
  // This function is TOTAL: it returns false for every invalid input and
  // NEVER throws. The previous implementation called `parseISODateTimeAsUTC`
  // (which THROWS an InvalidTypeValueError for an unparseable date) from the
  // right-hand side of a `||`, so the "is it NaN?" guard was unreachable:
  // any string the regex accepted but the engine could not parse made
  // `isValidISODate` THROW instead of returning false. The throw escaped the
  // Zod `.refine()` in schema-builders.ts and the class-validator constraint
  // in party.dto.ts as an opaque 500 / INTERNAL_ERROR.
  if (!ISO_DATE_REGEX.test(value)) return false;
  const parsed = new Date(normalizeISODateTimeToUTC(value)).getTime();
  if (Number.isNaN(parsed)) return false;
  // Use regex match groups instead of raw slice to stay robust against
  // future regex refactoring.
  const dateMatch = value.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
  if (!dateMatch) return false;
  const year = parseInt(dateMatch[1]!, 10);
  const month = parseInt(dateMatch[2]!, 10);
  const day = parseInt(dateMatch[3]!, 10);
  // Validate calendar range: reject years outside reasonable business range,
  // and enforce month-specific day limits (e.g. Feb 30).
  if (year < 1700 || year > 2200 || day > DAYS_IN_MONTH[month]!) return false;
  // Leap year check for February 29.
  if (month === 2 && day === 29) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!isLeap) return false;
  }
  return true;
}
