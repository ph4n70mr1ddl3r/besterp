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

  // Decode common HTML entities that might have been double-encoded.
  // Order matters: decode &amp; LAST because &amp;lt; → &lt; → <.
  // A second pass catches triple-encoding (e.g., &amp;amp;lt; → &amp;lt; → &lt; → <).
  for (let pass = 0; pass < 2; pass++) {
    const before = sanitized;
    sanitized = sanitized
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#x27;/gi, "'")
      .replace(/&#39;/gi, "'");
    // After decoding, strip any tags that were revealed
    sanitized = sanitized.replace(/<[^>]*>/g, "");
    // If nothing changed, no more entities to decode
    if (sanitized === before) break;
  }

  return sanitized;
}
