// Shared validation constants for BestERP.
//
// Centralises validation patterns used across packages to avoid
// duplication and ensure consistency.

/**
 * UUID validation regex — loosely matches standard UUID format.
 *
 * Allows both hyphenated (`550e8400-e29b-41d4-a716-446655440000`)
 * and non-hyphenated (`550e8400e29b41d4a716446655440000`) forms.
 *
 * Used by:
 * - Zod schemas in party-tools.ts
 * - PartyService.requireUuid()
 * - PartyController.requireUuid()
 */
export const UUID_REGEX =
  /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

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
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * E.164 country code validation — `+` followed by 1 to 3 digits.
 * Covers all real country codes (e.g. +1, +44, +81, +86) without allowing
 * arbitrary strings like "abc" or "+99999" to be stored as a country code.
 *
 * Used by PartyService.addContactMechanism (telecom type).
 */
export const COUNTRY_CODE_REGEX = /^\+\d{1,3}$/;
