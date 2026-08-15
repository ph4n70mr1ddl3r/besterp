// Shared validation constants for BestERP.
//
// Centralises validation patterns used across packages to avoid
// duplication and ensure consistency.

import { InvalidTypeValueError } from "./errors.js";

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
      `${fieldName} must be a string, received ${typeof value}.`,
      { context: { field: fieldName, receivedType: typeof value } }
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (value.length > 0) {
      throw new InvalidTypeValueError(
        `${fieldName} cannot be whitespace-only.`,
        { context: { field: fieldName } }
      );
    }
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new InvalidTypeValueError(
      `${fieldName} is too long (${trimmed.length} chars, max ${maxLength}).`,
      { context: { field: fieldName, length: trimmed.length, maxLength } }
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
 * The final TLD segment is alpha-only (`[a-zA-Z]{2,}`): numeric or
 * digit-containing TLDs like `example.123` / `example.c0m` never exist in
 * practice and are rejected, matching the rejection behavior of Zod's
 * `.email()` and class-validator's `@IsEmail` so all three surfaces agree.
 *
 * Used by:
 * - PartyService.addContactMechanism (email type)
 * - Zod schemas in party-tools.ts (via .email() — kept aligned by tests)
 * - DTOs in party.dto.ts (via class-validator's @IsEmail — kept aligned by tests)
 */
export const EMAIL_REGEX: RegExp = /^(?!\.)(?!.*\.\.)[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(?<!\.)@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(?:[a-zA-Z-]{0,61}[a-zA-Z])?$/;

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
 * ISO 8601 date validation regex.
 *
 * Accepts:
 * - `2024-06-15` (date-only)
 * - `2024-06-15T00:00:00` (local time)
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
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(Z|T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|\+14:00|-12:00|\+(0\d|1[0-3]):[0-5]\d|-(0\d|1[0-1]):[0-5]\d)?)?$/;

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
  if (!ISO_DATE_REGEX.test(value) || Number.isNaN(new Date(value).getTime())) {
    return false;
  }
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
