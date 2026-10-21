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
    const decimal = value as { toNumber?: () => number; toString?: () => string };
    if (typeof decimal.toNumber === "function") {
      try {
        const parsed = decimal.toNumber();
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        // Fall through to the string representation below.
      }
    }
    if (typeof decimal.toString === "function") {
      try {
        const parsed = Number(decimal.toString());
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}
