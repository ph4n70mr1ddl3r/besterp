// Reusable Zod schema builders for MCP tool input schemas.
// Centralized so party-tools and product-tools share one definition
// instead of duplicating them verbatim.

import { z } from "zod";
import { UUID_REGEX, isValidISODate, stripHtmlTags } from "@besterp/shared";

/** Required string: trims, strips HTML, enforces min/max length. */
export function sanitizedString(min: number, max: number) {
  return z.string()
    .transform(s => stripHtmlTags(s.trim()))
    .pipe(z.string().min(min).max(max));
}

/** Optional trimmed string that rejects whitespace-only input.
 *  Trims, strips HTML/script payloads, and normalises empty/whitespace-only input
 *  to undefined. Used for optional fields and search filters.
 *
 *  The length cap is enforced on the TRIMMED value (the `.pipe` below), not on
 *  the raw input: a value padded with whitespace to just over `max` is valid
 *  once trimmed, and the service layer and the required-field helper
 *  `sanitizedString` both length-check the trimmed value.
 *  A pre-transform `.max()` would reject exactly the padded-but-valid inputs
 *  the other surfaces accept — a cross-surface inconsistency. */
export function optionalFilteredString(max: number) {
  return z.string()
    .optional()
    .transform(s => {
      if (s === undefined || s === null) return undefined;
      const trimmed = stripHtmlTags(s.trim());
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .pipe(z.string().max(max).optional());
}

/** Optional search filter: REJECTS whitespace-only/HTML-only input instead of
 *  silently dropping it. The service layer's requireNonEmptyFilter treats a
 *  whitespace-only filter as a probable caller mistake and refuses to widen
 *  the query to "return all" — the REST DTO enforces the same contract.
 *  optionalFilteredString normalised "   " to undefined here, so the same
 *  request would silently return the unfiltered listing on MCP while REST
 *  returned 422: a cross-surface divergence with data-widening consequences. */
export function optionalSearchFilterString(max: number) {
  return z.string()
    .optional()
    .transform(s => (s === undefined ? undefined : stripHtmlTags(s.trim())))
    .pipe(
      z.string()
        .min(1, "Filter cannot be whitespace-only — provide a real filter or omit the field")
        .max(max)
        .optional()
    );
}

/** Optional ISO 8601 date: trims, validates format, enforces max length. */
export function optionalIsoDate(max: number = 50) {
  return z.string()
    .optional()
    .transform(s => s?.trim() || undefined)
    .pipe(z.string().max(max).optional())
    .refine(
      v => v === undefined || isValidISODate(v),
      "Invalid date format - must be ISO 8601"
    );
}

/**
 * UUID path parameter. Centralises the repeated id schema so every tool
 * shares one definition. The 36-char max matches the canonical UUID format;
 * UUID_REGEX is the real gatekeeper.
 */
export function uuidParam(description: string) {
  return z.string()
    .transform(s => s.trim())
    .pipe(z.string().min(1).max(36).regex(UUID_REGEX, "Must be a valid UUID"))
    .describe(description);
}
