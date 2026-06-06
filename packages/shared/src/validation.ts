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
