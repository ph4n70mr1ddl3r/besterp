// Input sanitization utilities for BestERP.
//
// Provides defense-in-depth against XSS by stripping HTML tags and
// script injection from user-provided text fields before storage.
//
// IMPORTANT: This is a DATA-LAYER defense. If data is ever rendered
// in a browser, the renderer must ALSO escape HTML. This sanitizer
// prevents stored XSS at the database level.

/**
 * Strip HTML tags and script content from a string.
 *
 * Removes:
 * - HTML tags (<script>, <div>, <img>, etc.)
 * - HTML entities that could bypass tag stripping
 * - Null bytes that could confuse parsers
 *
 * Does NOT:
 * - Encode special characters (that's the renderer's job)
 * - Validate email/URL format
 *
 * @param input - The raw string to sanitize
 * @returns Sanitized string with HTML tags removed
 */
export function stripHtmlTags(input: string): string {
  if (!input || typeof input !== "string") return input;

  // Remove null bytes (can confuse parsers and bypass filters)
  let sanitized = input.replace(/\0/g, "");

  // Remove script/style content including the tags themselves
  // Handles: <script>...</script>, <style>...</style>, with attributes
  sanitized = sanitized.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  sanitized = sanitized.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  // Remove HTML comments (can contain conditional comments for IE)
  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, "");

  // Remove all remaining HTML tags
  sanitized = sanitized.replace(/<[^>]*>/g, "");

  // Decode common HTML entities that might have been double-encoded
  // This prevents bypasses like &lt;script&gt; → <script>
  sanitized = sanitized
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'");

  // After decoding, strip any tags that were revealed
  sanitized = sanitized.replace(/<[^>]*>/g, "");

  return sanitized;
}

/**
 * Sanitize a text field for storage. Trims whitespace and strips HTML tags.
 *
 * @param value - The raw string to sanitize
 * @returns Trimmed, tag-stripped string, or undefined if input is empty/null
 */
export function sanitizeTextField(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value as unknown as string;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  return stripHtmlTags(trimmed);
}
