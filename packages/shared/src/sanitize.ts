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
const MAX_SANITIZE_ITERATIONS = 10;

export function stripHtmlTags(input: string): string {
  // Remove null bytes (can confuse parsers and bypass filters)
  let sanitized = input.replace(/\0/g, "");

  // Decode-then-strip loop: decode HTML entities, then strip any tags that
  // were revealed. Repeats until stable to handle nested/triple encoding
  // (e.g., &amp;amp;lt; → &amp;lt; → &lt; → < → stripped).
  // Capped at MAX_SANITIZE_ITERATIONS to prevent DoS via deeply nested encoding.
  let prev: string;
  let iterations = 0;
  do {
    prev = sanitized;

    // Decode numeric character references — these can bypass tag stripping
    // when embedded in attributes or content. Must run before tag removal.
    // e.g. &#60;script&#62; → <script>
    // Runs inside the loop so double-encoded entities (e.g. &amp;#x3c;)
    // are decoded across iterations: &amp;#x3c; → &#x3c; → <
    sanitized = sanitized.replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    sanitized = sanitized.replace(/&#(\d+);/g, (_, dec) =>
      String.fromCharCode(parseInt(dec, 10))
    );

    // Decode common HTML entities. Order matters: decode &amp; LAST because
    // &amp;lt; → &lt; → <.
    sanitized = sanitized
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#x27;/gi, "'")
      .replace(/&#39;/gi, "'");
    // Strip script/style content including the tags themselves
    sanitized = sanitized.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    sanitized = sanitized.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    // Remove HTML comments
    sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, "");
    // Remove all remaining HTML tags
    sanitized = sanitized.replace(/<[^>]*>/g, "");

    // Strip null bytes that may have been introduced by entity decoding
    // (e.g. &#x00; → \0).
    sanitized = sanitized.replace(/\0/g, "");

    iterations++;
  } while (sanitized !== prev && iterations < MAX_SANITIZE_ITERATIONS);

  return sanitized;
}
