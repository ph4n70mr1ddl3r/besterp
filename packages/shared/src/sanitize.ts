import { InvalidTypeValueError } from "./errors.js";

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
  // Measure in UTF-8 bytes, not UTF-16 code units. Multi-byte characters
  // (CJK, emoji) occupy up to 4 bytes each, so a string of 99k such chars is
  // ~400 KB — far above the intended 100 KB budget. Measuring code units
  // would let a crafted multi-byte string slip past the cap and then balloon
  // further inside the decode loop (entity decoding can expand length).
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_LENGTH) {
    throw new InvalidTypeValueError(
      `stripHtmlTags: input exceeds maximum allowed length. ` +
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
    sanitized = sanitized.replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) =>
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
    // Remove all remaining HTML tags (must have at least one non-whitespace
    // char after < to avoid treating plain text like "< >" as a tag)
    sanitized = sanitized.replace(/<[^\s>][^>]*>/g, "");
    // Strip incomplete/orphaned opening tags (missing closing >)
    sanitized = sanitized.replace(/<[a-zA-Z][^>]*$/gm, "");

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
  return sanitizeLogMessage(message)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/redis:\/\/[^\s"']+/gi, "[REDIS_URL]")
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/mysql:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/amqps?:\/\/[^\s"']+/gi, "[MESSAGE_BROKER_URL]")
    // Redact query strings that may carry secrets (API keys, tokens, passwords)
    // even on non-credential URLs. This MUST run BEFORE the generic
    // `(https?:\/\/)[^\s...]+ → [HOST]/[PATH]` rule below: that rule consumes
    // the entire URL including the trailing `?key=sk_live_abc123`, so the
    // secret would otherwise be collapsed into `[PATH]` and survive verbatim
    // in operator logs. Scrub the secret-bearing parameters first so the
    // host/path collapse then leaves nothing sensitive behind.
    .replace(/(?<=[?&])((?:key|token|secret|password|access_token|auth|api_key|apikey|client_secret)=)[^&\s"']+/gi, (m) => {
      // Strip trailing punctuation ( ), ] } that a secret could be wrapped in
      // (e.g. inside a stack trace, curl snippet, or JSON) so the boundary char
      // is not left behind after redaction and the secret is fully scrubbed.
      return m.replace(/^\[+|[\])}\s]+$/g, "") + "[REDACTED]";
    })
    // Redact high-entropy bearer/secret tokens that appear outside the
    // key=value form above (e.g. `Authorization: Bearer sk_live_...` echoed in
    // an auth-failure error, or a bare JWT). The JWT pattern is conservative:
    // three dot-separated base64url segments, which is structurally distinct
    // from ordinary prose.
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/(https?:\/\/)[^\s"')}]+/gi, "$1[HOST]/[PATH]")
    .replace(/(?:ftp|sftp):\/\/[^\s"')}]+/gi, "[FTP_URL]")
    .replace(/(?:ws|wss):\/\/[^\s"')}]+/gi, "[WEBSOCKET_URL]")
    // Generic catch-all for credential-bearing URLs whose scheme isn't
    // explicitly listed above (e.g. ldap://, ldaps://, ssh://, vault://,
    // smtp://, or custom schemes). A driver/library error can embed such a
    // URL with inline userinfo (user:pass@), and the scheme-specific
    // patterns above would let it through verbatim — leaking credentials
    // to operator logs.
    //
    // Only matches when a userinfo segment (`user:pass@`) is present, so
    // credential-free URLs of arbitrary schemes (e.g. `file:///path`,
    // `custom://host`) are left untouched. Runs AFTER the scheme-specific
    // patterns so they keep their labelled output ([DATABASE_URL],
    // [REDIS_URL], …) — this only catches what they miss.
     .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@"']+:[^\s/@"']+@[^\s"']+/g, "[REDACTED_URL]")
     // Redact filesystem paths, but only when they are absolute (leading `/`
     // with two or more segments, a `~/` home path, or a Windows drive root).
     // This avoids corrupting ordinary prose such as "meet me at /home/user
     // later" — the previous `\bat\b\s*/...` rule collapsed that to
     // "meet me [PATH] later" and destroyed legitimate log context. A path is
     // only redacted when it cannot be mistaken for prose: it must begin at a
     // boundary and have at least two non-empty segments.
      .replace(/(^|\s)(?:\/(?:[^\s'":/]+\/)+[^\s'":/]*\.[^\s'":/]+(?::\d+)?|~\/[^\s'":/]+\/[^\s'":/]*\.[^\s'":/]+(?::\d+)?|[A-Za-z]:\\[^\s'":]+(?::\d+)?)/g, "$1[PATH]");
}

/**
 * Strip newlines, carriage returns, tabs, and ANSI escape sequences from strings
 * to prevent log injection via user-controlled messages.
 */
export function sanitizeLogMessage(s: string): string {
  // Strip newlines, carriage returns, tabs, and ANSI escape sequences to
  // prevent log injection via user-controlled messages. ANSI escapes can
  // manipulate terminal output (e.g., clearing screen, changing colors).
  //
  // Order matters: ANSI sequences must be removed BEFORE control character
  // replacement because the ESC byte (\x1b) that starts ANSI sequences is
  // itself a control character that would otherwise be replaced first.
  //
  // Handles three categories of ANSI escape sequences:
  // 1. CSI (Control Sequence Introducer): ESC [ parameters letter
  // 2. String-type: OSC (ESC ]), APC (ESC _), SOS (ESC X), PM (ESC ^),
  //    DCS (ESC P) — terminated by ST (ESC \) or BEL (\x07)
  // 3. Non-CSI single- or multi-character: ESC optionally followed by zero or
  //    more intermediate bytes (0x20–0x2F, e.g. space, $, (, ), +, /) and
  //    then a final byte in the ECMA-48 range 0x30–0x7E. Examples:
  //    - ESC M (RI — reverse index): one final byte, zero intermediates
  //    - ESC c (RIS — reset): lowercase final byte
  //    - ESC ( B (select character set): intermediate ( then final B
  //    - ESC $ ( C (select Korean charset): intermediates $ ( then final C
  //
  // The final-byte range covers the full ECMA-48 range 0x30–0x7E, INCLUDING
  // lowercase letters (a–z). Lowercase finals are valid ESC sequences:
  // ESC c = RIS (full terminal reset), ESC n = LS2, ESC o = LS3, etc.
  // The ESC initiator is always neutralized by the control-char pass below,
  // so omitting intermediate bytes was not a security hole — but trailing
  // bytes survived as stray characters (e.g. "\x1b(B" → "_(B" instead of ""),
  // so the sequences are now fully stripped for log readability.
  //
  // C1 control characters (U+0080–U+009F) are also stripped. U+009B (CSI)
  // is a valid C1 control that many modern terminals accept as an alternative
  // to ESC+[ for ANSI escape sequences. Without this, an attacker could inject
  // \u009B31m to set text color without triggering any of the ESC-based
  // removal patterns above. This is defense-in-depth: real-world terminals
  // rarely interpret C1 controls over plain socket connections, but stripping
  // them eliminates the vector entirely.
  /* eslint-disable no-control-regex */
  return s
    // CSI: ESC [ parameter-bytes (0x30–0x3F) final-byte (0x40–0x7E)
    .replace(/\x1b\[[\x30-\x3F]*[\x40-\x7E]/g, "")
    .replace(/\x1b[\]_X^P][\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, "")
    // Unicode bidirectional override/isolate controls and zero-width characters.
    // These can manipulate terminal display to hide injected log content or
    // create misleading log entries (e.g., U+202E RIGHT-TO-LEFT OVERRIDE).
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u200B\u200C\u200D\u2060\u2066-\u2069\u202A-\u202E\uFEFF]/g, "")
    .replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, "_");
  /* eslint-enable no-control-regex */
}

/**
 * Compose sanitizeLogMessage (log injection prevention) with sanitizeLogOutput
 * (sensitive URL/path redaction). Apply log-injection sanitization FIRST so
 * control characters and ANSI escapes are removed before the URL/path regexes
 * run against the clean text.
 *
 * Use this in error handlers, shutdown routines, and any context where an
 * unknown or user-controlled message could contain both log-injection payloads
 * (ANSI escapes, newlines) and sensitive connection strings or paths.
 */
export function sanitizeForLogOutput(message: string): string {
  return sanitizeLogOutput(sanitizeLogMessage(message));
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
  // Explicitly check lone surrogates first: String.fromCodePoint() stopped
  // throwing for these in ES2024, but we must still replace them to prevent
  // invalid Unicode from reaching the database.
  if (codePoint >= 0xD800 && codePoint <= 0xDFFF) {
    return "\uFFFD";
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    // Negative, out-of-range (> 0x10FFFF), or NaN — replace with
    // U+FFFD (replacement character) to avoid crashing the sanitizer loop.
    return "\uFFFD";
  }
}
