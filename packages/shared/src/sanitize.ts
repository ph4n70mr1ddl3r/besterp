// Input sanitization utilities for BestERP.
//
// Provides defense-in-depth against XSS by stripping HTML tags and
// script injection from user-provided text fields before storage.
//
// IMPORTANT: This is a DATA-LAYER defense. If data is ever rendered
// in a browser, the renderer must ALSO escape HTML. This sanitizer
// prevents stored XSS at the database level.

import { DEFAULT_PHONE_COUNTRY_CODE } from "./constants.js";
import { InvalidTypeValueError } from "./errors.js";

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
const TEXT_ENCODER = new TextEncoder();

const MAX_SANITIZE_ITERATIONS = 20;
const MAX_INPUT_LENGTH = 100_000;

export function stripHtmlTags(input: string): string {
  if (input.length === 0) return input;
  if (TEXT_ENCODER.encode(input).length > MAX_INPUT_LENGTH) {
    // Thrown as a structured domain error (not a plain Error) so the REST
    // filter and the MCP error-handler report an actionable client error
    // (422 / INVALID_TYPE_VALUE) instead of an opaque 500 INTERNAL_ERROR.
    // A plain Error thrown from inside a Zod `.transform()` is NOT converted
    // into a ZodIssue — it escapes the parse entirely.
    throw new InvalidTypeValueError(
      `Input exceeds the maximum allowed length of ${MAX_INPUT_LENGTH} bytes.`,
      { context: { maxBytes: MAX_INPUT_LENGTH, actualBytes: TEXT_ENCODER.encode(input).length } }
    );
  }

  let sanitized = input.replace(/\0/g, "");

  const maxIntermediateBytes = MAX_INPUT_LENGTH * 10;
  let prev: string;
  let iterations = 0;
  do {
    prev = sanitized;
    sanitized = decodeNumericEntities(sanitized);
    sanitized = decodeCommonEntities(sanitized);
    sanitized = stripScriptStyleContent(sanitized);
    sanitized = stripOrphanedScriptStyleTags(sanitized);
    sanitized = stripHtmlComments(sanitized);
    sanitized = stripRemainingHtmlTags(sanitized);
    sanitized = stripIncompleteOpeningTags(sanitized);
    sanitized = stripControlCharacters(sanitized);

    iterations++;
    if (TEXT_ENCODER.encode(sanitized).length > maxIntermediateBytes) {
      throw new InvalidTypeValueError(
        `Sanitized output exceeded ${maxIntermediateBytes} bytes during HTML sanitization.`,
        { context: { maxBytes: maxIntermediateBytes } }
      );
    }
  } while (sanitized !== prev && iterations < MAX_SANITIZE_ITERATIONS);

  return sanitized;
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
  if (Number.isNaN(codePoint)) return "\uFFFD";
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

/** Decode numeric character references (&#xHH; and &#DDD;) to Unicode. */
function decodeNumericEntities(input: string): string {
  return input
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)));
}

/**
 * Decode common HTML entities. Order matters: `&apos;` (and the other named
 * entities) decode BEFORE `&amp;` so `&amp;apos;` decodes across iterations;
 * `&amp;` is second-to-last and `&quot;` last. Decoding `&quot;` after
 * `&amp;` still converges: `&amp;quot;` fully decodes to `"` in one pass of
 * the outer iteration loop rather than two (the loop re-runs until the value
 * is stable, bounded by MAX_SANITIZE_ITERATIONS).
 */
function decodeCommonEntities(input: string): string {
  return input
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"');
}

// ─── Linear-time HTML scanners ────────────────────────────────────
//
// The four helpers below used to be regular expressions. Every one of them
// combined a GREEDY `[^>]*` (or a lazy `[\s\S]*?`) with a REQUIRED trailing
// literal, which is the textbook shape for catastrophic backtracking:
//
//   /<script\b[^>]*>[\s\S]*?<\/script>/gi   — `[^>]*` + required `>`
//   /<!--[\s\S]*?-->/g                      — lazy run + required `-->`
//   /<[^\s>][^>]*>/g                        — `[^>]*` + required `>`
//
// When the input contains many `<` starts but NO `>` after them, the engine
// consumes the whole remaining string with `[^>]*` and then backtracks one
// character at a time looking for the missing `>` — once per start position.
// That is O(n²) and it is a REAL denial-of-service, not a theoretical one:
// a single 100 KB request body of "<a" repeated blocked the Node event loop
// for 2.6 SECONDS (measured), and `stripHtmlTags` runs on every user-supplied
// party/product name, description and contact field — in the REST DTOs, in
// every MCP tool's Zod `.transform()`, and in the service layer. The 100 KB
// `MAX_INPUT_LENGTH` guard is exactly the size that made it reachable.
//
// The replacements below are hand-written SCANNERS: each one advances a
// monotonically increasing cursor, so the total work is O(n) regardless of
// the input's shape. They are semantically equivalent to the regexes they
// replace — same matches, same removal spans — and the behaviour is pinned
// by the regression tests in __tests__/sanitize.test.ts.

/** ASCII whitespace, matching the JS `\s` class used by the original regexes. */
function isAsciiOrUnicodeWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** True for the characters JavaScript's `\w` matches (letters, digits, `_`). */
function isWordCharacter(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * ASCII-only case-insensitive comparison of `text` against `needle`
 * (which must already be lower-case) starting at `at`.
 */
function matchesLowerAsciiAt(text: string, lowerNeedle: string, at: number): boolean {
  if (at + lowerNeedle.length > text.length) return false;
  for (let i = 0; i < lowerNeedle.length; i++) {
    let code = text.charCodeAt(at + i);
    // ASCII fold: 'A'..'Z' -> 'a'..'z'. Non-ASCII characters are compared
    // verbatim, which is correct for every tag name we match.
    if (code >= 65 && code <= 90) code += 32;
    if (code !== lowerNeedle.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Index of the first case-insensitive occurrence of `lowerNeedle` at or
 * after `from`, or -1.
 *
 * The scan advances monotonically, so a chain of calls that each start
 * where the previous one stopped costs O(n) in total.
 */
function indexOfLowerAscii(text: string, lowerNeedle: string, from: number): number {
  for (let i = Math.max(0, from); i + lowerNeedle.length <= text.length; i++) {
    if (matchesLowerAsciiAt(text, lowerNeedle, i)) return i;
  }
  return -1;
}

/**
 * Index of the next `<tag` opening at or after `from`, honouring the `\b`
 * word-boundary that the original regexes applied after the tag name
 * (`<scriptx>` is NOT a script tag — `x` is a word character).
 *
 * Returns -1 when no such opening exists.
 */
function findTagOpening(text: string, lowerTag: string, from: number): number {
  let i = text.indexOf("<", Math.max(0, from));
  while (i !== -1) {
    const nameStart = i + 1;
    if (matchesLowerAsciiAt(text, lowerTag, nameStart)) {
      const afterName = nameStart + lowerTag.length;
      // `\b` after a word character holds when the next character is NOT a
      // word character, or when the tag name ends the string.
      if (afterName >= text.length || !isWordCharacter(text.charAt(afterName))) {
        return i;
      }
    }
    i = text.indexOf("<", i + 1);
  }
  return -1;
}

/**
 * Remove `<tag ...>` blocks, INCLUDING the closing `>`.
 *
 * Equivalent to the old `/<tag\b[^>]*\/?>/gi`: the attribute run cannot
 * contain `>`, so the match always ends at the FIRST `>` after the tag name.
 */
function stripTagsWithClosing(input: string, lowerTag: string): string {
  let result = "";
  let pos = 0;
  for (;;) {
    const start = findTagOpening(input, lowerTag, pos);
    if (start === -1) {
      result += input.slice(pos);
      return result;
    }
    const nameEnd = start + 1 + lowerTag.length;
    const gt = input.indexOf(">", nameEnd);
    if (gt === -1) {
      // No `>` anywhere after this opening: neither this occurrence nor any
      // later one can match, so the rest of the string is kept verbatim.
      result += input.slice(pos);
      return result;
    }
    result += input.slice(pos, start);
    pos = gt + 1;
  }
}

/**
 * Remove `<tag ...` runs WITHOUT a closing `>`, i.e. up to (but not
 * including) the next `>` or the end of the string.
 *
 * Equivalent to the old `/<tag\b[^>]*` + `/gi` pattern.
 */
function stripTagsWithoutClosing(input: string, lowerTag: string): string {
  let result = "";
  let pos = 0;
  for (;;) {
    const start = findTagOpening(input, lowerTag, pos);
    if (start === -1) {
      result += input.slice(pos);
      return result;
    }
    const nameEnd = start + 1 + lowerTag.length;
    const gt = input.indexOf(">", nameEnd);
    const end = gt === -1 ? input.length : gt;
    result += input.slice(pos, start);
    pos = end;
  }
}

/** Remove script/style content including tags, and orphaned opening tags. */
function stripScriptStyleContent(input: string): string {
  // Equivalent to /<script\b[^>]*>[\s\S]*?<\/script>/gi and its <style>
  // twin: the opening tag ends at the first `>`, and the content runs to the
  // FIRST closing tag (the old `[\s\S]*?` was lazy). The <style> pass runs on
  // the OUTPUT of the <script> pass, exactly as the chained `.replace()` did.
  return stripScriptStyleBlocks(
    stripScriptStyleBlocks(input, "script", "</script>"),
    "style",
    "</style>",
  );
}

/**
 * Remove every `<tag ...>content</tag>` block.
 *
 * `lowerTag` is the lower-cased tag name and `lowerCloseTag` the lower-cased
 * closing tag (with its `>`), both matched case-insensitively.
 */
function stripScriptStyleBlocks(input: string, lowerTag: string, lowerCloseTag: string): string {
  let result = "";
  let pos = 0;
  for (;;) {
    const start = findTagOpening(input, lowerTag, pos);
    if (start === -1) {
      result += input.slice(pos);
      return result;
    }
    const nameEnd = start + 1 + lowerTag.length;
    const gt = input.indexOf(">", nameEnd);
    if (gt === -1) {
      // The opening tag is never closed: no block can be matched here, and no
      // later opening can be closed either (a closing tag would need a `>`).
      result += input.slice(pos);
      return result;
    }
    const close = indexOfLowerAscii(input, lowerCloseTag, gt + 1);
    if (close === -1) {
      result += input.slice(pos);
      return result;
    }
    result += input.slice(pos, start);
    pos = close + lowerCloseTag.length;
  }
}

/** Handle orphaned <script>/<style> opening tags without proper closing tags. */
function stripOrphanedScriptStyleTags(input: string): string {
  // Pass 1 — openings that DO have a closing `>`: `<script ...>`.
  const withClosing = stripTagsWithClosing(
    stripTagsWithClosing(input, "script"),
    "style",
  );
  // Pass 2 — bare <script>/<style> that lack a closing > entirely
  // (e.g. "<script malicious") — the generic incomplete-tag rule below
  // only matches when followed by whitespace or end-of-string, so these
  // must be caught here to avoid leaking script/style content.
  return stripTagsWithoutClosing(
    stripTagsWithoutClosing(withClosing, "script"),
    "style",
  );
}

/** Remove HTML comments. */
function stripHtmlComments(input: string): string {
  // Equivalent to /<!--[\s\S]*?-->/g: only COMPLETE comments are removed,
  // and the content runs to the FIRST `-->` after the opening marker.
  let result = "";
  let pos = 0;
  for (;;) {
    const start = input.indexOf("<!--", pos);
    if (start === -1) {
      result += input.slice(pos);
      return result;
    }
    const end = input.indexOf("-->", start + 4);
    if (end === -1) {
      result += input.slice(pos);
      return result;
    }
    result += input.slice(pos, start);
    pos = end + 3;
  }
}

/**
 * Remove all remaining HTML tags (must have at least one non-whitespace char
 * after < to avoid treating plain text like "< >" as a tag).
 */
function stripRemainingHtmlTags(input: string): string {
  // Equivalent to /<[^\s>][^>]*>/g. The attribute run cannot contain `>`, so
  // a match always ends at the FIRST `>` after the tag name; when there is no
  // `>` at all the opening cannot match and the scan moves on by one
  // character, exactly like the regex engine does.
  let result = "";
  let pos = 0;
  for (;;) {
    const lt = input.indexOf("<", pos);
    if (lt === -1) {
      result += input.slice(pos);
      return result;
    }
    const nameStart = lt + 1;
    if (nameStart >= input.length) {
      // A trailing `<` has no character after it, so `[^\s>]` cannot match.
      result += input.slice(pos);
      return result;
    }
    const ch = input.charAt(nameStart);
    if (ch === ">" || isAsciiOrUnicodeWhitespace(ch)) {
      // `[^\s>]` rejects whitespace and `>` — no match at this position.
      result += input.slice(pos, nameStart);
      pos = nameStart;
      continue;
    }
    const gt = input.indexOf(">", nameStart + 1);
    if (gt === -1) {
      // No `>` anywhere after — the match cannot complete here.
      result += input.slice(pos, nameStart);
      pos = nameStart;
      continue;
    }
    result += input.slice(pos, lt);
    pos = gt + 1;
  }
}

/** Strip incomplete/orphaned opening tags (missing closing >). */
function stripIncompleteOpeningTags(input: string): string {
  // Match an opening tag name (<div, <span, etc.) only when it is followed
  // by whitespace or end-of-string. This avoids greedily consuming trailing
  // text that is not part of the tag (e.g. "text <div more" → "text  more"
  // instead of "text "). Script/style bare openings are handled by
  // stripOrphanedScriptStyleTags above.
  return input.replace(/<[a-zA-Z]{2,}(?=\s|$)/g, "");
}

/**
 * Strip C0 control characters (U+0000–U+001F) and DEL (U+007F) that may have
 * been introduced by entity decoding (e.g. &#x7F; → DEL).
 */
function stripControlCharacters(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Maximum input length fed to the URL/path redaction regexes. Unlike
 * `stripHtmlTags`, this function has no inherent length cap, and two of its
 * regexes (the generic `scheme://user:pass@host` catch-all below) have a
 * greedy unbounded scheme prefix that triggers catastrophic backtracking
 * (O(n²)) on a long run of letters with no `://` — an event-loop-blocking
 * ReDoS on hot, agent-facing and durable-persist paths. Bound the input so no
 * downstream regex can be fed an unbounded string.
 *
 * Same bound as `MAX_INPUT_LENGTH` (the `stripHtmlTags` cap) so the two
 * length guards in this module cannot silently drift apart — they used to be
 * two independent literals with the same value.
 */
const MAX_LOG_OUTPUT_LENGTH = MAX_INPUT_LENGTH;

/**
 * Options for {@link sanitizeForLogOutput}.
 */
export interface SanitizeForLogOutputOptions {
  /**
   * Keep "opaque" tokens (a 20-128 character run that mixes letters and
   * digits) verbatim instead of rewriting them to `[REDACTED_TOKEN]`.
   *
   * The generic long-token rule exists to catch secrets whose shape is not
   * recognisable (a random base64 blob). It cannot tell those apart from a
   * legitimate opaque IDENTIFIER — so it rewrote a perfectly legal user id
   * such as `ServiceAccount12345678` into `[REDACTED_TOKEN]`, destroying the
   * audit correlation the row exists to provide.
   *
   * Use this for values that are already charset-validated (identifiers),
   * where the recognised-secret rules (provider keys, connection strings,
   * `name=value` pairs, URLs, paths) still apply but an opaque token is a
   * legitimate value. NEVER use it for free-form user input.
   */
  keepOpaqueTokens?: boolean;
}

export function sanitizeForLogOutput(message: string, options?: SanitizeForLogOutputOptions): string {
  // Defensive length cap (mirrors the guard in stripHtmlTags). Without it, a
  // long attacker-influenced error message / tool output / validation `received`
  // value could trigger O(n²) backtracking in the URL catch-all regex below and
  // block the Node event loop (DoS). The .slice(...) truncation applied by
  // callers happens AFTER this runs, so it cannot mitigate the cost.
  if (TEXT_ENCODER.encode(message).length > MAX_LOG_OUTPUT_LENGTH) {
    // Truncate on a CHARACTER boundary (not UTF-16 code units) so the result
    // stays within the byte budget and is never cut mid-multi-byte character.
    // String.prototype.slice counts UTF-16 code units, so slicing a run of
    // CJK/emoji at the same numeric index could keep far more than 100 KB of
    // UTF-8 bytes — defeating the DoS cap the guard exists to enforce.
    let end = 0;
    let byteCount = 0;
    const chars = [...message];
    for (; end < chars.length; end++) {
      const chBytes = TEXT_ENCODER.encode(chars[end]).length;
      if (byteCount + chBytes > MAX_LOG_OUTPUT_LENGTH) break;
      byteCount += chBytes;
    }
    message = end > 0 ? chars.slice(0, end).join("") : "";
  }
  const result = sanitizeLogMessage(message);
  // Order is critical: URL/host/path rules must run BEFORE the generic
  // long-token catch-all so URLs are collapsed to [HOST]/[PATH] first.
  // The generic rule runs LAST so it only sees tokens the specific rules
  // did not already consume.
  //
  // Each entry is a named function so the pipeline is easy to read, extend,
  // and test independently — nesting function calls deepens the call stack
  // with no additional insight and makes it harder to add a step without
  // reformatting the entire chain.
  const pipeline: Array<(s: string) => string> = [
    replaceDatabaseUrls,
    replaceQuerySecrets,
    replaceBoundarySecrets,
    replaceQuotedSecrets,
    replaceBearerAndJwtTokens,
    replaceProviderSecrets,
    replaceHostPaths,
    replaceCredentialUrls,
    replaceFilesystemPaths,
  ];
  if (options?.keepOpaqueTokens !== true) {
    pipeline.push(replaceGenericLongToken);
  }
  return pipeline.reduce((acc, fn) => fn(acc), result);
}

/** Replace database connection strings (postgres, redis, mongodb, mysql, amqp). */
function replaceDatabaseUrls(input: string): string {
  return input
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/redis:\/\/[^\s"']+/gi, "[REDIS_URL]")
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/mysql:\/\/[^\s"']+/gi, "[DATABASE_URL]")
    .replace(/amqps?:\/\/[^\s"']+/gi, "[MESSAGE_BROKER_URL]");
}

// ─── Free-text secret rules ───────────────────────────────────────
//
// Three rules redact `name=value` / `name: value` shaped secrets in free
// text, query strings and quoted values.
//
// They are all driven by ONE predicate — {@link isFreeTextSecretName} — which
// delegates to the canonical `isSensitiveFieldName` (the same predicate the
// object-key redactor uses). The previous implementation carried its own
// fixed alternation of secret names, and the two lists had drifted apart:
// `mfa`, `credentials`, `passphrase`, `authorization`, `clientSecret`,
// `accessToken` and every compound such as `private_key` / `access_key` were
// redacted when they appeared as an OBJECT KEY but leaked verbatim in free
// text, where the same secret should have been scrubbed. That asymmetry is
// exactly the leak class this module exists to prevent.
//
// A "name" in free text is captured as a WHOLE (snake_case, kebab-case or
// camelCase) so the sensitivity decision is made on the complete name —
// `clientSecret`, `x-api-key` and `db_private_key` are recognised — instead
// of on a hand-maintained list of spellings that could never stay in sync
// with the field-name rules.

// Names that the free-text rules deliberately do NOT treat as secret
// markers even though `isSensitiveFieldName` flags them: they over-redact
// benign prose ("status code=200 ok", "session=abc123"). The query-string
// and quoted-value rules re-add them, because a URL parameter or a quoted
// value is structured rather than prose.
const FREE_TEXT_PROSE_EXCLUSIONS: ReadonlySet<string> = Object.freeze(new Set([
  "code", "session",
]));

// Names the free-text rules treat as secret markers even though
// `isSensitiveFieldName` does NOT flag them. `key` alone cannot be part of
// the field-name rules (it would flag `primaryKey` / `sortKey` /
// `foreignKey`), but in a `name=value` position — a config dump, a query
// string, a log line — a bare `key` IS a credential. `client_id` and
// `bearer` are the same shape of judgement: they are credential markers in
// free text but ordinary identifiers as field names.
const FREE_TEXT_EXTRA_SECRET_NAMES: ReadonlySet<string> = Object.freeze(new Set([
  "key", "client_id", "bearer",
]));

/**
 * True when a NAME captured from free text denotes a secret.
 *
 * @param allowCodeAndSession - the query-string and quoted-value rules pass
 *   `true` because a URL parameter or a quoted value is structured, not
 *   prose ("code=200" in a query string is still a value worth scrubbing).
 */
function isFreeTextSecretName(name: string, allowCodeAndSession = false): boolean {
  const lower = name.toLowerCase();
  if (!allowCodeAndSession && FREE_TEXT_PROSE_EXCLUSIONS.has(lower)) return false;
  if (FREE_TEXT_EXTRA_SECRET_NAMES.has(lower)) return true;
  return isSensitiveFieldName(name);
}

// A name in free text: an identifier-ish run. Kept deliberately permissive
// (letters, digits, `_`, `-`, `.`) so `clientSecret`, `x-api-key` and
// `db_private_key` are all captured whole and the sensitivity decision is
// made on the complete name.
//
// The first character may be a DIGIT. The name used to require a leading
// letter, which created an asymmetry with the object-key redactor:
// `isSensitiveFieldName("2fa_secret")` is true (the token fallback splits it
// into `2fa` + `secret`), so the SAME name was redacted as an object key but
// survived verbatim in free text — `2fa_secret=abc123` leaked, and the
// generic long-token rule could not save it because the whole run is 19
// characters, one below that rule's 20-character minimum. A leading digit is
// harmless: the sensitivity decision is still made by
// `isFreeTextSecretName`, so `2=2` and `1234=5678` stay untouched.
const FREE_TEXT_NAME = "[A-Za-z0-9][A-Za-z0-9_.-]{0,63}";

// `String.raw` preserves regex backslash escapes verbatim, so each pattern
// below is byte-for-byte the intended regex source.
//
// The query-string rule previously required `name=` with NO whitespace
// around the separator, so `?api_key = secret` was never matched; and the
// name had to be one of a fixed alternation, so `?x_token=secret` (a
// qualified parameter name) leaked. Both are fixed below: the separator may
// be surrounded by whitespace, and the name is captured whole.
const QUERY_SECRET_PATTERN = new RegExp(
  String.raw`(?<=[?&#;])([ \t]*(${FREE_TEXT_NAME})[ \t]*=[ \t]*)([^&;\s"']+)`,
  "gi",
);
// `name: value` and `name = value` are the canonical YAML/config/log forms
// (`password: hunter2`, `client_secret = abc`) and were previously left
// verbatim because the pattern required `name=value` with no separator
// whitespace. Allow an optional `:` or `=` with optional surrounding
// whitespace. The quoted-value rule (QUOTED_SECRET_PATTERN) still owns
// quoted values: its `"…"` value class is excluded here, so `password:
// "hunter2"` continues to flow to that rule unchanged.
//
// The name may be followed by a CLOSING quote before the separator. A
// single-quoted map (`{'api_key': sk_live_abc}`) puts a quote between the
// name and the `:`; without this the quote defeated the separator and the
// whole pair survived verbatim. The quote is captured so the replacement can
// re-emit it and keep the text's shape recognisable.
const BOUNDARY_SECRET_PATTERN = new RegExp(
  String.raw`(^|[\s"'{([,;])(${FREE_TEXT_NAME})(['"]?)[ \t]*[:=][ \t]*([^}\]\s"'\` ,;]+)`,
  "gi",
);
// The name's own quote characters AND the `:`/`=` separator are captured so
// the redaction can be substituted back verbatim. Dropping them turned
// `{"api_key":"sk_live_abc"}` into `{api_key=[REDACTED]}` — the redacted
// string was no longer valid JSON, so a consumer that parses a JSON-in-text
// payload after redaction (audit rows, idempotency records, agent-facing
// errors) could no longer parse it.
//
// The name's quotes may be SINGLE as well as double. The value alternative
// already accepted both quote characters, so only the name did not — and a
// single-quoted map (`{'api_key':'sk_live_abc'}`, a Python `repr`, a JS
// object literal, a YAML-ish dump) leaked the secret verbatim while the
// identical double-quoted map was redacted.
const QUOTED_SECRET_PATTERN = new RegExp(
  String.raw`(^|[\s"'{([;,?])(['"]?)(${FREE_TEXT_NAME})(['"]?)[ \t]*([:=])[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`,
  "gi",
);

/**
 * Auth schemes whose credential is redacted by a dedicated rule.
 *
 * `Authorization: Bearer <token>` must NOT be rewritten by the generic
 * `name=value` rule: the value class stops at whitespace, so the rule would
 * consume the SCHEME (`Bearer`) and leave the credential behind — and the
 * dedicated Bearer/Basic rule would then no longer recognise it. Skipping
 * the generic rule for these values keeps the scheme intact and lets
 * `replaceBearerAndJwtTokens` redact the credential as
 * "Bearer [REDACTED]".
 */
const AUTH_SCHEME_VALUE = /^(?:Bearer|Basic)$/i;

/**
 * Redact secrets in URL query strings and fragments.
 *
 * MUST run BEFORE the generic URL host/path collapse: that rule consumes the
 * entire URL including trailing `?key=secret`, so the secret would otherwise
 * survive verbatim in `[PATH]`. Scrub secrets first so the host/path collapse
 * leaves nothing sensitive behind.
 */
function replaceQuerySecrets(input: string): string {
  return input.replace(
    QUERY_SECRET_PATTERN,
    (match, prefix: string, name: string) =>
      isFreeTextSecretName(name, true) ? `${prefix}[REDACTED]` : match,
  );
}

/**
 * Redact secrets in free text / JSON-in-text that appear outside a URL query
 * string, e.g. `password=hunter2` or `{"api_key":"sk_live_abc"}`.
 */
function replaceBoundarySecrets(input: string): string {
  return input.replace(
    BOUNDARY_SECRET_PATTERN,
    (match, lead: string, name: string, nameClose: string, value: string) => {
      if (!isFreeTextSecretName(name)) return match;
      // Leave `Authorization: Bearer …` / `Authorization: Basic …` to the
      // dedicated auth rules (see AUTH_SCHEME_VALUE).
      if (AUTH_SCHEME_VALUE.test(value)) return match;
      // The closing quote captured between the name and the separator is
      // re-emitted so a single-quoted map keeps its shape:
      // `{'api_key': sk_live}` → `{'api_key'=[REDACTED]}`.
      return `${lead}${name}${nameClose}=[REDACTED]`;
    },
  );
}

/**
 * Redact secrets wrapped in quotes: `"api_key":"value"` or `password="value"`.
 *
 * The quote characters are PRESERVED. Dropping them turned
 * `{"api_key":"sk_live_abc"}` into `{api_key=[REDACTED]}` — the redacted
 * string was no longer valid JSON, so any consumer that parses a
 * JSON-in-text payload after redaction (audit rows, idempotency records,
 * agent-facing errors) failed to parse it.
 */
function replaceQuotedSecrets(input: string): string {
  return input.replace(
    QUOTED_SECRET_PATTERN,
    (match, lead: string, nameOpen: string, name: string, nameClose: string, sep: string, value: string) => {
      if (!isFreeTextSecretName(name, true)) return match;
      const quote = value.startsWith("'") ? "'" : '"';
      return `${lead}${nameOpen}${name}${nameClose}${sep}${quote}[REDACTED]${quote}`;
    },
  );
}

/** Redact Bearer tokens, Basic auth credentials, and JWTs. */
function replaceBearerAndJwtTokens(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    // Basic auth: `<Basic base64>`. The `Basic` scheme is matched
    // case-insensitively via explicit `[Bb]` classes (NOT the `i` flag, which
    // would also make the token character class case-insensitive and corrupt
    // prose like "basic principles" → the token must contain at least one
    // uppercase letter, digit, `+`, `/`, or `=` padding, which pure-lowercase
    // prose words never do. base64 of ASCII credentials almost always mixes
    // cases and/or carries digits/padding.
    .replace(/\b[Bb][Aa][Ss][Ii][Cc]\s+[A-Za-z0-9+/=]*[A-Z0-9+/=][A-Za-z0-9+/=]*/g, "Basic [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]");
}

/**
 * Redact well-known provider secret prefixes (AWS, Stripe, GitHub, Slack, Google).
 *
 * These are matched by shape/prefix rather than by key name, catching secrets
 * stored under non-sensitive field names (e.g. `config.value`).
 */
function replaceProviderSecrets(input: string): string {
  return input
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]")
    .replace(/\b(?:sk|rk|pk|ssk)_(?:live|test)_[A-Za-z0-9]{8,}/gi, "[REDACTED_API_KEY]")
    // GitHub personal-access tokens: `ghp_…`, `gho_…`, … (underscore form).
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|glpat|dop_v1)_[A-Za-z0-9]{16,}/g, "[REDACTED_TOKEN]")
    // GitLab personal-access tokens: `glpat-…` (HYPHEN form). The previous
    // revision listed `glpat-` as an alternative of the underscore pattern
    // above, where it was unreachable — the pattern required a trailing `_`,
    // so the real GitLab format was never matched.
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\b(?:AIza)[A-Za-z0-9_-]{35}/g, "[REDACTED_GOOGLE_KEY]")
    .replace(/\b(?:ya29\.)[A-Za-z0-9_-]{20,}/g, "[REDACTED_GOOGLE_TOKEN]");
}

// ULID (Crockford base32, 26 chars): the dominant identity-ID shape across
// the MCP ecosystem (Anthropic/Claude user, conversation, and thread IDs are
// ULIDs). Must be whitelisted or legitimate identity values would be redacted
// to "[REDACTED_TOKEN]" everywhere they are logged/persisted — defeating
// audit trails. Charset excludes I/L/O/U per the Crockford spec.
// Accept BOTH cases: Claude IDs are lowercase in practice, and a
// lowercase-only whitelist would redact exactly the IDs this rule preserves.
const ULID_CHARSET = "0-9A-HJKMNP-TV-Za-hjkmnp-tv-z";
const ULID_PATTERN = new RegExp(`^[0-9][${ULID_CHARSET}]{25}$`);
// Prefixed forms such as `usr_<ULID>`, `agent_<ULID>`, `conv_<ULID>`.
const PREFIXED_ULID_PATTERN = new RegExp(`^[a-z][a-z0-9]{0,19}_[0-9][${ULID_CHARSET}]{25}$`);

// A dotted lower-case identifier: a DNS name / host / email domain /
// package coordinate. At least two dot-separated labels, each label made of
// lower-case alphanumerics and dashes (no leading/trailing dash).
//
// These are STRUCTURED values, not opaque secrets. The generic long-token
// rule cannot tell them apart from a random blob, and redacting them
// silently corrupts legitimate data — an agent that created a contact with
// the address "contact@acme-trading.example.com" got back
// "contact@[REDACTED_TOKEN]".
const DOTTED_IDENTIFIER_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function replaceGenericLongToken(input: string): string {
  // Use a state-machine scan instead of a single greedy regex to avoid
  // catastrophic backtracking on long runs of matching characters. The
  // original `/[A-Za-z0-9_./=+-]{20,128}/g` is a greedy quantifier with a
  // character class that overlaps common text — on adversarial input the
  // engine re-evaluates the alternations (ULID check, prefix check, hex
  // check, etc.) per match position, yielding O(n²) behaviour on strings
  // near the MAX_LOG_OUTPUT_LENGTH cap. Scanning manually picks each
  // candidate ONCE and never backtracks.
  const result: string[] = [];
  let pos = 0;
  // The candidate is a MAXIMAL run of token characters, and the whole run is
  // consumed as ONE candidate.
  //
  // The upper bound of 128 used to be part of the pattern, which meant a run
  // LONGER than 128 characters was split into a 128-character chunk plus a
  // remainder. When the remainder was shorter than the 20-character minimum
  // it was not matched at all and survived VERBATIM: a 141-character opaque
  // secret was redacted down to "[REDACTED_TOKEN]" plus its last 13
  // characters — the exact durable-sink leak this module exists to prevent.
  // Matching the maximal run fixes that, and the shape checks below then see
  // the whole token (which can only make them redact MORE of a secret, never
  // less).
  //
  // `{20,}` on a plain character class is linear: the engine consumes the
  // maximal run in one pass and never backtracks (there is no trailing
  // requirement for it to give back characters for).
  const candidateRe = /[A-Za-z0-9_./=+-]{20,}/g;
  let match: RegExpExecArray | null;
  while ((match = candidateRe.exec(input)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    // Skip matches already consumed by a previous iteration (should not
    // happen with /g, but guard against overlapping engine behaviour).
    if (matchStart < pos) continue;
    result.push(input.slice(pos, matchStart));
    const candidate = match[0];
    // NOTE: a "is this already a redaction placeholder?" check used to live
    // here (`/^\[REDACTED(?:_[A-Z_]+)?\]$/`), but it was DEAD CODE: the
    // candidate character class (`[A-Za-z0-9_./=+-]`) cannot contain a
    // bracket, so a candidate can never equal a bracketed placeholder. The
    // branch was removed rather than left as misleading dead code; the
    // placeholder-shaped tokens that DO reach this point (e.g.
    // `REDACTED_DATABASE_URL`) are preserved by the all-letters rule below.
    if (ULID_PATTERN.test(candidate)) {
      result.push(candidate);
    } else if (PREFIXED_ULID_PATTERN.test(candidate)) {
      result.push(candidate);
    } else if (/^[a-z]+$/.test(candidate)) {
      result.push(candidate);
    } else if (/^[a-f0-9]+$/i.test(candidate)) {
      result.push(candidate);
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
      result.push(candidate);
    } else if (/^[a-zA-Z0-9_-]+$/.test(candidate)) {
      const hasLetter = /[a-zA-Z]/.test(candidate);
      const hasDigit = /[0-9]/.test(candidate);
      result.push(hasLetter && hasDigit ? "[REDACTED_TOKEN]" : candidate);
    } else if (DOTTED_IDENTIFIER_PATTERN.test(candidate)) {
      // A dotted, lower-case identifier — a hostname, an email domain, a
      // package name. These are STRUCTURED values, not opaque secrets, and
      // redacting them silently corrupts legitimate data: the generic rule
      // used to rewrite "acme-trading.example.com" to "[REDACTED_TOKEN]",
      // so an agent that created a contact with that address got a mangled
      // value back and could not read it.
      result.push(candidate);
    } else {
      result.push("[REDACTED_TOKEN]");
    }
    pos = matchEnd;
  }
  result.push(input.slice(pos));
  return result.join("");
}

/** Collapse URLs to [HOST]/[PATH] form (http, https, ftp, sftp, ws, wss). */
function replaceHostPaths(input: string): string {
  return input
    .replace(/(https?:\/\/)[^\s"')}]+/gi, "$1[HOST]/[PATH]")
    .replace(/(?:ftp|sftp):\/\/[^\s"')}]+/gi, "[FTP_URL]")
    .replace(/(?:ws|wss):\/\/[^\s"')}]+/gi, "[WEBSOCKET_URL]");
}

/**
 * Redact credential-bearing URLs with userinfo (`user:pass@host`) whose scheme
 * isn't explicitly handled by the database URL or host/path rules.
 *
 * Only matches when a userinfo segment is present, so credential-free URLs
 * (e.g. `file:///path`) are left untouched.
 */
function replaceCredentialUrls(input: string): string {
  return input.replace(/[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\/[^\s:"']+:[^\s:"']+@[^\s"']+/g, "[REDACTED_URL]");
}

/**
 * Redact absolute filesystem paths (Unix `/a/b/c.ext`, Windows `C:\path`, `~/path`).
 *
 * Requires at least two non-empty segments AND a file extension in the final
 * segment, so prose like "meet me at /home" or "retry at /admin/reindex" is
 * not corrupted. The extension requirement is deliberate: without it every
 * multi-segment path in ordinary prose ("see /var/log/app") would be
 * rewritten, which destroys readability without protecting anything — the
 * paths that matter (config files, source files, keys) all carry an
 * extension.
 */
function replaceFilesystemPaths(input: string): string {
  return input.replace(
    /(^|\s)(?:\/(?:[^\s'":/]+\/)+[^\s'":/]*\.[^\s'":/]+(?::\d+)?|~\/[^\s'":/]+\/[^\s'":/]*\.[^\s'":/]+(?::\d+)?|[A-Za-z]:\\[^\s'":]+(?::\d+)?)/g,
    "$1[PATH]",
  );
}

/**
 * Strip newlines, carriage returns, tabs, and ANSI escape sequences from strings
 * to prevent log injection via user-controlled messages.
 */
export function sanitizeLogMessage(message: string): string {
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
  return message
    // CSI: ESC [ parameter-bytes (0x30–0x3F) final-byte (0x40–0x7E)
    .replace(/\x1b\[[\x30-\x3F]*[\x40-\x7E]/g, "")
    .replace(/\x1b[\]_X^P][\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, "")
    // Unicode bidirectional override/isolate controls and zero-width characters.
    // These can manipulate terminal display to hide injected log content or
    // create misleading log entries (e.g., U+202E RIGHT-TO-LEFT OVERRIDE).
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u200B\u200C\u200D\u200E\u200F\u2060-\u2069\u202A-\u202E\u061C\uFEFF]/g, "")
    // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are ECMA-262
    // line terminators that fall in the gap between the ranges stripped above
    // (\u2060-\u2069 and \u202A-\u202E). Many terminals/log viewers render
    // them as real line breaks, so an attacker embedding \u2028 in a
    // user-controlled message could forge an extra log line — the exact
    // log-injection class this function prevents. Map them to "_" like the
    // C0 line breaks below.
    .replace(/[\u2028\u2029]/g, "_")
    .replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, "_");
  /* eslint-enable no-control-regex */
}

/** @deprecated Use {@link sanitizeForLogOutput} instead. */
export function sanitizeLogOutput(message: string): string {
  return sanitizeForLogOutput(message);
}

/**
 * Field names whose *values* must be redacted before an object is reflected to
 * an agent or persisted to a durable sink (audit log, idempotency record),
 * regardless of which surface emits it.
 *
 * Kept as a single source of truth so the REST `DomainExceptionFilter`, the MCP
 * error-handler, and the audit-log/idempotency middlewares cannot diverge on
 * what counts as sensitive — a value under a sensitive-named key that one
 * surface redacts but another reflects is an asymmetric secret-leak path.
 */
const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = Object.freeze(new Set([
  "password", "passwd", "pwd", "secret", "token", "api_key", "apiKey",
  "authorization", "creditcard", "credit_card", "ssn", "taxid", "tax_id",
  "access_token", "refresh_token", "session_id", "sessionid",
  "private_key", "privatekey", "secret_key", "secretkey",
  "accesskey", "access_key", "encryption_key", "encryptionkey",
  "pin", "cc_number", "card_number", "date_of_birth", "dob",
  "birthdate", "birth_date", "dateofbirth",
  "bank_account", "routing_number", "national_id", "passport",
  "otp", "otp_code", "one_time_password", "mfa", "mfa_secret",
  "passcode", "passphrase", "signature", "sign", "session", "code",
]));

/**
 * Catch-all sensitive field pattern (snake/kebab/camel aware).
 *
 * `\\b` is deliberately NOT used: `_` is a word character under `\\w`, so
 * `\\btoken\\b` would miss `session_token`, `client_secret`, etc. Alnum-only
 * lookarounds treat `_`/`-` as separators, catching both snake_case and
 * camelCase variants while rejecting infix matches inside unrelated words.
 */
const SENSITIVE_FIELD_NAME_PATTERN =
  /(?<![a-z0-9])(password|passwd|pwd|secret|token|api[_-]?key|credential|auth(?:token|key|code|orization|[_-](?:token|key|code))?|signature|otp|mfa|passcode|passphrase|sign)(?![a-z0-9])/i;

/**
 * Split a field name into tokens at snake_case, kebab-case, and camelCase
 * boundaries (e.g. `clientSecret` → [`client`, `Secret`],
 * `access_token` → [`access`, `token`], `api-key` → [`api`, `key`]).
 *
 * Acronym runs are kept together (`userAPIKey` → [`user`, `API`, `Key`],
 * not [`user`, `A`, `P`, `I`, `Key`]) so a compound like `APIKey` is still
 * recognised as an adjacent `api`+`key` token pair.
 */
function splitFieldNameTokens(key: string): string[] {
  // Insert a boundary between a lowercase/digit and a following uppercase
  // (`clientSecret` → `client Secret`), then split an acronym run from a
  // trailing Capitalised word (`APIKey` → `API Key`).
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced
    .split(/[\s_-]+/)
    .filter((t) => t.length > 0);
}

/** Public tokeniser used by consumers that need to split field names into tokens. */
export { splitFieldNameTokens };

const SENSITIVE_FIELD_TOKENS: ReadonlySet<string> = Object.freeze(new Set([
  "password", "passwd", "pwd", "secret", "token", "credential", "credentials",
  "otp", "mfa", "passcode", "passphrase", "signature", "sign",
  // `authorization` is a single-word entry of SENSITIVE_FIELD_NAMES, so the
  // exact-set lookup only catches it as a WHOLE name. Adding it here also
  // catches it as a camelCase COMPONENT ("proxyAuthorization",
  // "userAuthorization"), which the regex branch cannot see: the regex's
  // `(?<![a-z0-9])` lookbehind rejects a match preceded by a letter, and
  // the `i` flag makes that lookbehind reject an UPPERCASE predecessor too.
  // This mirrors how "password" and "token" already flag compound names
  // ("passwordPolicy", "tokenCount").
  "authorization",
]));

/**
 * Returns true if a field name matches a sensitive pattern. Four layers:
 * 1. Exact match against the explicit `SENSITIVE_FIELD_NAMES` set.
 * 2. The `SENSITIVE_FIELD_NAME_PATTERN` regex (snake/kebab/camel aware).
 * 3. A token-based fallback that splits on camelCase + snake/kebab boundaries
 *    and checks each token against `SENSITIVE_FIELD_TOKENS` — catches camelCase
 *    names (`clientSecret`, `bearerToken`) the regex's alnum lookarounds miss.
 * 4. A token-SUBSEQUENCE rule: the field name contains one of the explicit
 *    set's COMPOUND entries as a contiguous run of tokens.
 *
 * Layer 4 exists because the exact set holds compound names
 * (`private_key`, `access_key`, `encryption_key`, `authorization`,
 * `session_id`) whose component tokens are NOT in `SENSITIVE_FIELD_TOKENS`
 * and whose spelling the regex cannot see (the regex's lookbehind rejects a
 * match preceded by `_`/`-`, and `auth(?:…)?` cannot match `authorization`
 * because the trailing lookahead fails on the following `o`). Without layer 4
 * the SAME secret was redacted under `private_key` but leaked verbatim under
 * `db_private_key` — an asymmetric leak, exactly the class the single
 * source of truth is meant to prevent.
 *
 * `key`/`code`/`session` are intentionally NOT token fallbacks: they
 * over-redact benign names (`primaryKey`, `foreignKey`, `sortKey`,
 * `statusCode`). Key-bearing sensitive fields are covered by the explicit set
 * and the `api[_-]?key` regex branch.
 *
 * The `api` + `key` COMPOUND is sensitive even though `key` alone is not:
 * `clientApiKey` / `userAPIKey` / `my-api-key` all name an API credential,
 * while `primaryKey` / `idempotencyKey` name an identifier. The regex branch
 * cannot see the compound because `api` is preceded by an alphanumeric
 * character (the lookbehind rejects the match), so the token-pair rule closes
 * that gap.
 */
export function isSensitiveFieldName(key: string): boolean {
  if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) return true;
  if (SENSITIVE_FIELD_NAME_PATTERN.test(key)) return true;
  const tokens = splitFieldNameTokens(key).map((t) => t.toLowerCase());
  if (tokens.some((t) => SENSITIVE_FIELD_TOKENS.has(t))) return true;
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i] === "api" && tokens[i + 1] === "key") return true;
  }
  return containsSensitiveCompound(tokens);
}

/**
 * The compound entries of {@link SENSITIVE_FIELD_NAMES}, pre-split into
 * lowercase token runs.
 *
 * Only entries that contain a separator are included: a single-token entry
 * (`password`, `token`, …) is already covered by the exact-set lookup and
 * the token fallback, and including it here would over-redact benign names
 * (`session_code`, `passenger`).
 */
const SENSITIVE_COMPOUND_TOKEN_RUNS: readonly (readonly string[])[] = Object.freeze(
  Array.from(SENSITIVE_FIELD_NAMES)
    .filter((name) => name.includes("_"))
    .map((name) => name.split("_").filter((t) => t.length > 0)),
);

/**
 * True when the field's token run contains one of the sensitive compound
 * names as a contiguous subsequence.
 *
 * `db_private_key` → tokens `[db, private, key]` contains `[private, key]` ✓
 * `aws_access_key`  → tokens `[aws, access, key]` contains `[access, key]` ✓
 * `user_authorization` → tokens `[user, authorization]` contains `[authorization]` ✓
 * `primary_key`     → tokens `[primary, key]` — no compound entry matches ✗
 */
function containsSensitiveCompound(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  for (const run of SENSITIVE_COMPOUND_TOKEN_RUNS) {
    if (run.length === 0 || run.length > tokens.length) continue;
    for (let start = 0; start + run.length <= tokens.length; start++) {
      let matched = true;
      for (let offset = 0; offset < run.length; offset++) {
        if (tokens[start + offset] !== run[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }
  return false;
}

/**
 * Maximum recursion depth for {@link redactSensitiveFieldValues}. Beyond this
 * the traversal stops and returns `"[Too deep]"` — mirroring the depth guard
 * on the MCP `redactSensitiveFields` / `sanitizeContextValue` consumers, so a
 * maliciously deep `DomainError.context` cannot blow the stack on the REST
 * dev-reflection path (which invokes this function on an attacker-influenceable
 * context tree).
 */
export const MAX_REDACTION_DEPTH = 20;

/**
 * Recursively redact values stored under sensitive-named keys within an
 * arbitrary object/array/Map/Set tree, while also running every string leaf
 * through `sanitizeForLogOutput` (URL/connection-string/secret redaction) so
 * the result is safe to reflect to an agent or persist to a durable sink.
 *
 * This is the canonical, single-source-of-truth redactor shared by the REST
 * `DomainExceptionFilter` AND the MCP agent/durable surfaces (audit-log,
 * error-handler, idempotency). It is keyed on {@link isSensitiveFieldName} so
 * every surface agrees on what counts as sensitive, and it handles Map/Set
 * containers (converting them to JSON-safe arrays while still redacting
 * sensitive-named keys) and guards against both unbounded recursion (depth
 * cap) and container cycles (WeakSet) — the exact properties the MCP
 * `redactSensitiveFields` carries, so the two surfaces cannot diverge.
 *
 * A NULL/UNDEFINED value under a sensitive-named key is LEFT ALONE. Absence
 * is not secrecy: replacing `null` with `"[REDACTED]"` made "no value on
 * file" indistinguishable from "a value we refuse to disclose", so every
 * party without a birth date reported one, and an agent could not tell
 * whether the field it wrote was actually stored.
 *
 * @param value value to redact (object, array, Map, Set, string, or primitive)
 * @param depth internal recursion depth; do not pass from callers
 * @param seen  internal cycle-tracking set; do not pass from callers
 */
function redactArray(value: unknown[], depth: number, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    return value.map((item) => redactSensitiveFieldValues(item, depth + 1, seen));
  } finally {
    seen.delete(value);
  }
}

function redactMap(value: Map<unknown, unknown>, depth: number, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    // Map is not JSON-native; convert to an array of [key, value] pairs so the
    // data survives serialisation (a bare Map would become {} and be silently
    // dropped from a reflected/durable payload). Sensitive-named keys are
    // redacted (mirroring the MCP audit-log redactor) so a secret stored under a
    // Map key is not reflected verbatim on any surface.
    return [...value.entries()].map(([k, v]) => {
      const keyStr = typeof k === "string" ? k : String(k);
      const sensitive = isSensitiveFieldName(keyStr);
      return [
        sensitive ? "[REDACTED]" : redactSensitiveFieldValues(k, depth + 1, seen),
        sensitive && v !== null && v !== undefined
          ? "[REDACTED]"
          : redactSensitiveFieldValues(v, depth + 1, seen),
      ];
    });
  } finally {
    seen.delete(value);
  }
}

function redactSet(value: Set<unknown>, depth: number, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    return [...value].map((v) => redactSensitiveFieldValues(v, depth + 1, seen));
  } finally {
    seen.delete(value);
  }
}

function redactPlainObject(value: Record<string, unknown>, depth: number, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    // `Object.create(null)` — not `{}` — so a `__proto__` key in the input
    // becomes an ordinary own data property instead of invoking the
    // `Object.prototype.__proto__` setter. With a normal object literal the
    // key was silently DROPPED (never created as an own property) and the
    // prototype of the result was replaced by the attacker-supplied child
    // object, so `out.<attackerKey>` resolved through the prototype chain.
    // Mirrors the prototype-safe construction in crypto.ts's sortPlainObject.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      // A NULL/UNDEFINED value is ABSENT, not withheld: redacting it to
      // "[REDACTED]" made "no birth date on file" indistinguishable from
      // "a birth date we refuse to show", and an agent could not tell
      // whether the field it wrote was stored. Only a value that actually
      // carries something is replaced.
      out[key] = isSensitiveFieldName(key) && child !== null && child !== undefined
        ? "[REDACTED]"
        : redactSensitiveFieldValues(child, depth + 1, seen);
    }
    return out;
  } finally {
    // Ancestor-set semantics: the container is only "in progress" while its
    // subtree is being walked. Without the delete, a DAG (the same sub-object
    // referenced from two siblings — not a cycle) was misreported as
    // "[Circular]" and its data was silently dropped from the redacted output.
    seen.delete(value);
  }
}

function handleDepthLimit(value: unknown): unknown {
  if (value != null && typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map(() => "[Too deep]");
    }
    if (value instanceof Map) {
      return [...value.keys()].map((k) => {
        const keyStr = typeof k === "string" ? k : String(k);
        return [isSensitiveFieldName(keyStr) ? "[REDACTED]" : "[Too deep]", "[Too deep]"];
      });
    }
    if (value instanceof Set) {
      return [...value].map(() => "[Too deep]");
    }
    if (value instanceof WeakMap || value instanceof WeakSet) return "[WeakCollection]";
    const capped: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key] of Object.entries(value as Record<string, unknown>)) {
      capped[key] = isSensitiveFieldName(key) ? "[REDACTED]" : "[Too deep]";
    }
    return capped;
  }
  return "[Too deep]";
}

function redactTypedObject(value: object, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof WeakMap || value instanceof WeakSet) return "[WeakCollection]";
  if (Array.isArray(value)) return redactArray(value, depth, seen);
  if (value instanceof Map) return redactMap(value, depth, seen);
  if (value instanceof Set) return redactSet(value, depth, seen);
  return redactPlainObject(value as Record<string, unknown>, depth, seen);
}

export function redactSensitiveFieldValues(
  value: unknown,
  depth = 0,
  seen?: WeakSet<object>,
): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    return handleDepthLimit(value);
  }
  if (typeof value === "string") return sanitizeForLogOutput(value);
  if (value === null || typeof value !== "object") return value;
  const s = seen ?? new WeakSet<object>();
  return redactTypedObject(value, depth, s);
}

/**
 * Sanitize a postal address object by stripping HTML from all fields.
 *
 * The REQUIRED fields (addressLine1, city, country) are validated and a
 * structured `InvalidTypeValueError` is thrown when one is missing. The
 * previous implementation called `.trim()` on them directly, so a missing
 * field produced a raw `TypeError: Cannot read properties of undefined
 * (reading 'trim')` — not a DomainError, so the REST filter answered with a
 * generic 500 instead of an actionable 422, and the MCP error-handler
 * reported it as an opaque INTERNAL_ERROR.
 */
export function sanitizePostalAddress(addr: {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  stateProvince?: string | null;
  postalCode?: string | null;
  country: string;
}): {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateProvince: string | null;
  postalCode: string | null;
  country: string;
} {
  const addressLine1 = requireStringField(addr.addressLine1, "addressLine1");
  const city = requireStringField(addr.city, "city");
  const country = requireStringField(addr.country, "country");
  const addressLine2 = optionalStringField(addr.addressLine2, "addressLine2");
  const stateProvince = optionalStringField(addr.stateProvince, "stateProvince");
  const postalCode = optionalStringField(addr.postalCode, "postalCode");
  return {
    addressLine1: stripHtmlTags(addressLine1),
    addressLine2: addressLine2 ? (stripHtmlTags(addressLine2) || null) : null,
    city: stripHtmlTags(city),
    stateProvince: stateProvince ? (stripHtmlTags(stateProvince) || null) : null,
    postalCode: postalCode ? (stripHtmlTags(postalCode) || null) : null,
    country: stripHtmlTags(country.toUpperCase()),
  };
}

/**
 * Sanitize a telecom number object by stripping HTML from all fields.
 *
 * The REQUIRED fields (areaCode, lineNumber) are validated and a structured
 * `InvalidTypeValueError` is thrown when one is missing. The previous
 * implementation defaulted them to the EMPTY STRING, so a caller that
 * omitted a required field silently persisted `areaCode: ""` /
 * `lineNumber: ""` — a row that violates the domain's "a phone number has
 * an area code and a line number" invariant and can never be corrected
 * through the API.
 */
export function sanitizeTelecomNumber(tel: {
  countryCode?: string | null;
  areaCode: string;
  lineNumber: string;
  extension?: string | null;
}, defaultCountryCode: string = DEFAULT_PHONE_COUNTRY_CODE): {
  countryCode: string;
  areaCode: string;
  lineNumber: string;
  extension: string | null;
} {
  const areaCode = requireStringField(tel.areaCode, "areaCode");
  const lineNumber = requireStringField(tel.lineNumber, "lineNumber");
  const countryCode = optionalStringField(tel.countryCode, "countryCode");
  const extension = optionalStringField(tel.extension, "extension");
  return {
    // The default country code is sanitized as well, so a caller-supplied
    // default cannot smuggle HTML into the persisted row.
    countryCode: countryCode
      ? (stripHtmlTags(countryCode) || stripHtmlTags(defaultCountryCode))
      : stripHtmlTags(defaultCountryCode),
    areaCode: stripHtmlTags(areaCode),
    lineNumber: stripHtmlTags(lineNumber),
    extension: extension ? (stripHtmlTags(extension) || null) : null,
  };
}

/**
 * Require a non-empty string field, throwing a structured DomainError.
 */
function requireStringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidTypeValueError(`'${field}' must be a string.`, {
      context: { field, received: value === null ? "null" : typeof value },
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidTypeValueError(`'${field}' must not be empty.`, {
      context: { field },
    });
  }
  return trimmed;
}

/**
 * Read an OPTIONAL string field, returning `undefined` for null/undefined.
 *
 * The optional fields used to be read with `field?.trim()`, which only
 * short-circuits on null/undefined. A non-string value (a number, an
 * object, a boolean) therefore reached `.trim()` and produced a raw
 * `TypeError: field?.trim is not a function` — NOT a DomainError — so the
 * REST filter answered with a generic 500 INTERNAL_ERROR instead of an
 * actionable 422 INVALID_TYPE_VALUE, and the MCP error-handler reported an
 * opaque server fault for what is plainly a malformed client payload.
 *
 * The optional fields are now validated exactly like the required ones; a
 * present-but-not-a-string value is a client error, and an absent one is
 * still legitimately absent.
 */
function optionalStringField(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidTypeValueError(`'${field}' must be a string.`, {
      context: { field, received: typeof value },
    });
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
