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
/** Maximum input length to prevent DoS via deeply nested encoded strings. */
const MAX_INPUT_LENGTH = 100_000;

export function stripHtmlTags(input: string): string {
  // Early-exit for empty strings and oversized input. The length cap prevents
  // DoS via deeply nested HTML entity encoding (e.g., &amp;amp;amp;...) where
  // each iteration can expand the string, and the decode loop multiplies the
  // work. 100 KB is well above any legitimate text field (the largest field
  // MAX_PARTY_DESCRIPTION_LENGTH is 1000 chars).
  if (input.length === 0) return input;
  if (input.length > MAX_INPUT_LENGTH) {
    throw new Error(
      `stripHtmlTags: input too long (${input.length} chars, max ${MAX_INPUT_LENGTH}). ` +
      `This may indicate a DoS attempt via deeply nested HTML encoding.`
    );
  }

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
    sanitized = sanitized.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      safeFromCodePoint(parseInt(hex, 16))
    );
    sanitized = sanitized.replace(/&#(\d+);/g, (_, dec) =>
      safeFromCodePoint(parseInt(dec, 10))
    );

    // Decode common HTML entities. Order matters: decode &amp; LAST because
    // &amp;lt; → &lt; → <. Decode &apos; BEFORE &amp; so &amp;apos; decodes
    // across iterations: &amp;apos; → &apos; → '.
    sanitized = sanitized
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&apos;/gi, "'")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"');
    // Strip script/style content including the tags themselves
    sanitized = sanitized.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    sanitized = sanitized.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    // Handle orphaned <script>/<style> opening tags without proper closing tags
    sanitized = sanitized.replace(/<script\b[^>]*\/?>/gi, "");
    sanitized = sanitized.replace(/<style\b[^>]*\/?>/gi, "");
    // Remove HTML comments
    sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, "");
    // Remove all remaining HTML tags
    sanitized = sanitized.replace(/<[^>]*>/g, "");
    // Strip incomplete/orphaned opening tags (missing closing >)
    sanitized = sanitized.replace(/<[a-zA-Z][^>]*$/g, "");

    // Strip null bytes that may have been introduced by entity decoding
    // (e.g. &#x00; → \0).
    sanitized = sanitized.replace(/\0/g, "");

    // Strip C0 control characters (U+0000–U+001F) and DEL (U+007F) that
    // may have been introduced by entity decoding (e.g. &#x7F; → DEL).
    // These can corrupt log output and terminal displays.
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, "");

    iterations++;
  } while (sanitized !== prev && iterations < MAX_SANITIZE_ITERATIONS);

  return sanitized;
}

/**
 * Sanitize a log message to remove sensitive patterns (connection strings,
 * internal file paths, hostnames). Used by error handlers and shutdown
 * routines to prevent leaking infrastructure details in logs.
 */
export function sanitizeLogOutput(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/redis:\/\/[^\s"']+/gi, "[REDIS_URL]")
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/mysql:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/amqps?:\/\/[^\s"']+/gi, "[MESSAGE_BROKER_URL]")
    .replace(/((?:https?|redis|mysql|mongodb(?:\+srv)?):\/\/)[^/\s]+\//gi, "$1[HOST]/")
    .replace(/\bat\b[/\\][^\s"':]+/gi, "[PATH]");
}

/**
 * Strip newlines from strings to prevent log injection via user-controlled messages.
 */
export function sanitizeForLog(s: string): string {
  // Strip newlines, carriage returns, tabs, and ANSI escape sequences to
  // prevent log injection via user-controlled messages. ANSI escapes can
  // manipulate terminal output (e.g., clearing screen, changing colors).
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "_").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Safely decode a Unicode code point.
 *
 * `String.fromCodePoint()` throws RangeError for lone surrogates
 * (U+D800–U+DFFF), negative values, or values > 0x10FFFF. This wrapper
 * catches those and returns the Unicode replacement character so the
 * sanitizer loop continues without crashing.
 */
export function safeFromCodePoint(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    // Lone surrogate, negative, or out-of-range code point — replace with
    // U+FFFD (replacement character) to avoid crashing the sanitizer loop.
    return "\uFFFD";
  }
}
