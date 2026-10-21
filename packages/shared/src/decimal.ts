// Decimal conversion helper.
//
// Prisma maps PostgreSQL `DECIMAL`/`NUMERIC` columns to `Prisma.Decimal`
// (decimal.js), which the driver returns as an OBJECT — never a JS `number`.
// A mapper that checks `typeof value === "number"` therefore NEVER takes the
// numeric branch for a real database row: every stored amount was reported as
// `null` / an internal type error.
//
// This module is the single source of truth for turning a stored decimal into
// a plain number, shared by the product-price and agent-transaction-amount
// mappers so the two cannot drift.

/**
 * Convert a stored decimal value into a plain JavaScript number.
 *
 * Accepts:
 * - a plain `number` (returned as-is when finite),
 * - a `Prisma.Decimal` / decimal.js instance (via `toNumber()`),
 * - a numeric `string` (e.g. from a raw SQL projection),
 * - `null` / `undefined` (returns `null`).
 *
 * Returns `null` for any value that cannot be represented as a finite number
 * (NaN, Infinity, an unrecognised object) so a caller can distinguish "no
 * amount stored" from "an amount that could not be parsed".
 */
export function decimalToNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object") {
    return decimalObjectToNumber(value as { toNumber?: () => number; toString?: () => string });
  }
  return null;
}

/**
 * Convert the OBJECT form of a decimal (a `Prisma.Decimal` / decimal.js
 * instance) into a plain number.
 *
 * Split out of {@link decimalToNumber} to keep each function under the
 * lint complexity cap.
 */
function decimalObjectToNumber(decimal: { toNumber?: () => number; toString?: () => string }): number | null {
  if (typeof decimal.toNumber === "function") {
    try {
      const parsed = decimal.toNumber();
      // A non-finite result (NaN/Infinity) means the numeric conversion did
      // not succeed — fall through to the string representation rather than
      // returning null. decimal.js can overflow to Infinity for values
      // beyond Number.MAX_VALUE while its toString() still yields a
      // parseable literal, so the previous immediate `return null` threw
      // away a recoverable value.
      if (Number.isFinite(parsed)) return parsed;
    } catch {
      // Fall through to the string representation below.
    }
  }
  if (typeof decimal.toString === "function") {
    try {
      const literal = decimal.toString();
      // The string branch above trims and rejects an EMPTY value before
      // parsing it. The object branch must apply the SAME rule: `Number("")`
      // and `Number("  ")` are both 0, and `Number.isFinite(0)` is true, so
      // a decimal whose string form is blank was reported as an amount of
      // ZERO — a money value — instead of "no amount stored". That
      // contradicted this module's documented contract ("so a caller can
      // distinguish 'no amount stored' from 'an amount that could not be
      // parsed'") and made the two branches of the same helper disagree
      // about the same input shape.
      const trimmed = typeof literal === "string" ? literal.trim() : "";
      if (trimmed.length === 0) return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
