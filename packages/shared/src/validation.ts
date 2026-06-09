// Shared validation constants for BestERP.
//
// Centralises validation patterns used across packages to avoid
// duplication and ensure consistency.

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
export const UUID_REGEX: Readonly<RegExp> =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Pragmatic email validation regex — accepts the vast majority of real-world
 * addresses while rejecting obvious garbage (missing `@`, missing domain,
 * embedded whitespace, missing TLD). Intentionally NOT RFC 5322-compliant:
 * strict compliance produces a regex thousands of characters long and still
 * rejects addresses that are valid in practice (e.g. `user+tag@example.com`).
 *
 * Used by:
 * - PartyService.addContactMechanism (email type)
 * - Zod schemas in party-tools.ts (via .email() — kept aligned by tests)
 * - DTOs in party.dto.ts (via class-validator's @IsEmail — kept aligned by tests)
 */
export const EMAIL_REGEX: Readonly<RegExp> = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * E.164 country code validation — `+` followed by 1 to 3 digits, first digit
 * non-zero. Covers all real country codes (e.g. +1, +44, +81, +86) while
 * rejecting invalid codes like +0 or +01.
 *
 * Used by PartyService.addContactMechanism (telecom type).
 */
export const COUNTRY_CODE_REGEX: Readonly<RegExp> = /^\+[1-9]\d{0,2}$/;
