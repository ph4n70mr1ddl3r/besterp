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
const TEXT_ENCODER = new TextEncoder();

const MAX_SANITIZE_ITERATIONS = 20;
const MAX_INPUT_LENGTH = 100_000;

export function stripHtmlTags(input: string): string {
  if (input.length === 0) return input;
  if (TEXT_ENCODER.encode(input).length > MAX_INPUT_LENGTH) {
    throw new Error(
      `stripHtmlTags: input exceeds maximum allowed length (${MAX_INPUT_LENGTH} bytes). ` +
      `This may indicate a DoS attempt via deeply nested HTML encoding.`
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
      throw new Error(
        `stripHtmlTags: intermediate output exceeded ${maxIntermediateBytes} bytes during sanitization. ` +
        `This may indicate a DoS attempt via entity expansion.`
      );
    }
  } while (sanitized !== prev && iterations < MAX_SANITIZE_ITERATIONS);

  return sanitized;
}

/** Decode numeric character references (&#xHH; and &#DDD;) to Unicode. */
function decodeNumericEntities(input: string): string {
  return input
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)));
}

/**
 * Decode common HTML entities. Order matters: decode &amp; LAST because
 * &amp;lt; → &lt; → <. Decode &apos; BEFORE &amp; so &amp;apos; decodes
 * across iterations.
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

/** Remove script/style content including tags, and orphaned opening tags. */
function stripScriptStyleContent(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

/** Handle orphaned <script>/<style> opening tags without proper closing tags. */
function stripOrphanedScriptStyleTags(input: string): string {
  return input
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/<style\b[^>]*\/?>/gi, "");
}

/** Remove HTML comments. */
function stripHtmlComments(input: string): string {
  return input.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Remove all remaining HTML tags (must have at least one non-whitespace char
 * after < to avoid treating plain text like "< >" as a tag).
 */
function stripRemainingHtmlTags(input: string): string {
  return input.replace(/<[^\s>][^>]*>/g, "");
}

/** Strip incomplete/orphaned opening tags (missing closing >). */
function stripIncompleteOpeningTags(input: string): string {
  return input.replace(/<[a-zA-Z]{2,}[^>]*/g, "");
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
 */
const MAX_LOG_OUTPUT_LENGTH = 100_000;

export function sanitizeForLogOutput(message: string): string {
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
  // The generic rule runs LAST to avoid re-consuming legitimate placeholders.
  return replaceGenericLongToken(
    replaceFilesystemPaths(
      replaceCredentialUrls(
        replaceHostPaths(
          replaceProviderSecrets(
            replaceBearerAndJwtTokens(
              replaceQuotedSecrets(
                replaceBoundarySecrets(
                  replaceQuerySecrets(
                    replaceDatabaseUrls(result),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
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
    /(?<=[?&#;])((?:key|token|id_token|access_token|secret|password|passwd|pwd|auth|api_key|apikey|client_secret|client_id|signature|sign|otp|code|session|bearer)=)([^&;\s"']+)/gi,
    (_m, name) => `${name}[REDACTED]`,
  );
}

/**
 * Redact secrets in free text / JSON-in-text that appear outside a URL query
 * string, e.g. `password=hunter2` or `{"api_key":"sk_live_abc"}`.
 */
function replaceBoundarySecrets(input: string): string {
  return input.replace(
    /(^|[\s"'{([,;])((?:key|token|id_token|access_token|secret|password|passwd|pwd|auth|api_key|apikey|client_secret|client_id|signature|sign|otp|bearer))=([^}\]\s"'`,;]+)/gi,
    (_, lead, name) => `${lead}${name}=[REDACTED]`,
  );
}

/**
 * Redact secrets wrapped in quotes: `"api_key":"value"` or `password="value"`.
 */
function replaceQuotedSecrets(input: string): string {
  return input.replace(
    /(^|[\s"'{([;,?])"?((?:key|token|id_token|access_token|secret|password|passwd|pwd|auth|api_key|apikey|client_secret|client_id|signature|sign|otp|code|session|bearer))"?\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi,
    (_, lead, name) => `${lead}${name}=[REDACTED]`,
  );
}

/** Redact Bearer tokens and JWTs. */
function replaceBearerAndJwtTokens(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
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
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|glpat|glpat-|gldt|dop_v1)_[A-Za-z0-9]{16,}/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\b(?:AIza)[A-Za-z0-9_-]{35}/g, "[REDACTED_GOOGLE_KEY]")
    .replace(/\b(?:ya29\.)[A-Za-z0-9_-]{20,}/g, "[REDACTED_GOOGLE_TOKEN]");
}

/**
 * Catch-all for long high-entropy tokens that survived all specific rules above.
 * Uses heuristics to distinguish secrets from benign identifiers.
 */
const REDACTED_PLACEHOLDERS = /^\[REDACTED(?:_[A-Z_]+)?\]$/;

// ULID (Crockford base32, 26 chars): the dominant identity-ID shape across the
// MCP ecosystem (Anthropic/Claude user, conversation, and thread IDs are ULIDs).
// Must be whitelisted or legitimate identity values would be destroyed to
// "[REDACTED_TOKEN]" everywhere they are logged/persisted (buildContext,
// error-handler, audit-log). Charset excludes I/L/O/U per the Crockford spec.
const ULID_PATTERN = /^[0-9][0-9A-HJKMNP-TV-Z]{25}$/;
// Prefixed forms such as `usr_<ULID>`, `agent_<ULID>`, `conv_<ULID>`.
const PREFIXED_ULID_PATTERN = /^[a-z][a-z0-9]{0,19}_[0-9][0-9A-HJKMNP-TV-Z]{25}$/;

function replaceGenericLongToken(input: string): string {
  return input.replace(/[A-Za-z0-9_./=+-]{20,128}/g, (match) => {
    if (REDACTED_PLACEHOLDERS.test(match)) return match;
    if (ULID_PATTERN.test(match)) return match;
    if (PREFIXED_ULID_PATTERN.test(match)) return match;
    if (/^[a-z]+$/.test(match)) return match;
    if (/^[a-f0-9]+$/i.test(match)) return match;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match)) return match;
    if (/^[a-zA-Z0-9_-]+$/.test(match)) {
      const hasLetter = /[a-zA-Z]/.test(match);
      const hasDigit = /[0-9]/.test(match);
      if (!(hasLetter && hasDigit)) return match;
    }
    return "[REDACTED_TOKEN]";
  });
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
 * Requires at least two non-empty segments so prose like "meet me at /home"
 * is not corrupted.
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
  /(?<![a-z0-9])(password|passwd|pwd|secret|token|api[_-]?key|credential|auth(?:token|key|code|[_-](?:token|key|code))?|signature|otp|mfa|passcode|passphrase|sign)(?![a-z0-9])/i;

/**
 * Split a field name into tokens at snake_case, kebab-case, and camelCase
 * boundaries (e.g. `clientSecret` → [`client`, `Secret`],
 * `access_token` → [`access`, `token`], `api-key` → [`api`, `key`]).
 */
function splitFieldNameTokens(key: string): string[] {
  // Split on kebab/hyphen boundaries first, then on camelCase boundaries.
  // Without the hyphen split, kebab-case names like `api-key` would tokenize
  // to ["api-key"] (single token) and miss the sensitive "key" token.
  const hyphenSplit = key.split("-");
  const tokens: string[] = [];
  for (const part of hyphenSplit) {
    const matches = part.match(/[a-z0-9]+|[A-Z][a-z]*/g);
    if (matches) tokens.push(...matches);
  }
  return tokens.filter((t) => t.length > 0);
}

/** Public tokeniser used by consumers (e.g. the MCP `sensitive-fields` shim). */
export { splitFieldNameTokens };

const SENSITIVE_FIELD_TOKENS: ReadonlySet<string> = Object.freeze(new Set([
  "password", "passwd", "pwd", "secret", "token", "credential", "credentials",
  "otp", "mfa", "passcode", "passphrase", "signature", "sign",
]));

/**
 * Returns true if a field name matches a sensitive pattern. Three layers:
 * 1. Exact match against the explicit `SENSITIVE_FIELD_NAMES` set.
 * 2. The `SENSITIVE_FIELD_NAME_PATTERN` regex (snake/kebab/camel aware).
 * 3. A token-based fallback that splits on camelCase + snake/kebab boundaries
 *    and checks each token against `SENSITIVE_FIELD_TOKENS` — catches camelCase
 *    names (`clientSecret`, `bearerToken`) the regex's alnum lookarounds miss.
 *
 * `key`/`code`/`session` are intentionally NOT token fallbacks: they
 * over-redact benign names (`primaryKey`, `foreignKey`, `sortKey`,
 * `statusCode`). Key-bearing sensitive fields are covered by the explicit set
 * and the `api[_-]?key` regex branch.
 */
export function isSensitiveFieldName(key: string): boolean {
  if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) return true;
  if (SENSITIVE_FIELD_NAME_PATTERN.test(key)) return true;
  return splitFieldNameTokens(key).some((t) => SENSITIVE_FIELD_TOKENS.has(t.toLowerCase()));
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
 * @param value value to redact (object, array, Map, Set, string, or primitive)
 * @param depth internal recursion depth; do not pass from callers
 * @param seen  internal cycle-tracking set; do not pass from callers
 */
function redactArray(value: unknown[], depth: number, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  return value.map((item) => redactSensitiveFieldValues(item, depth + 1, seen));
}

function redactMap(value: Map<unknown, unknown>, depth: number, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  // Map is not JSON-native; convert to an array of [key, value] pairs so the
  // data survives serialisation (a bare Map would become {} and be silently
  // dropped from a reflected/durable payload). Sensitive-named keys are
  // redacted (mirroring the MCP audit-log redactor) so a secret stored under a
  // Map key is not reflected verbatim on any surface.
  return [...value.entries()].map(([k, v]) => {
    const keyStr = typeof k === "string" ? k : String(k);
    return [
      isSensitiveFieldName(keyStr) ? "[REDACTED]" : redactSensitiveFieldValues(k, depth + 1, seen),
      isSensitiveFieldName(keyStr) ? "[REDACTED]" : redactSensitiveFieldValues(v, depth + 1, seen),
    ];
  });
}

function redactSet(value: Set<unknown>, depth: number, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  return [...value].map((v) => redactSensitiveFieldValues(v, depth + 1, seen));
}

function redactPlainObject(value: Record<string, unknown>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  if (seen.has(value)) return "[Circular]" as unknown as Record<string, unknown>;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSensitiveFieldName(key)
      ? "[REDACTED]"
      : redactSensitiveFieldValues(child, depth + 1, seen);
  }
  return out;
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
    const capped: Record<string, unknown> = {};
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

/** Sanitize a postal address object by stripping HTML from all fields. */
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
  const addressLine2 = addr.addressLine2?.trim();
  const stateProvince = addr.stateProvince?.trim();
  const postalCode = addr.postalCode?.trim();
  return {
    addressLine1: stripHtmlTags(addr.addressLine1.trim()),
    addressLine2: addressLine2 ? stripHtmlTags(addressLine2) : null,
    city: stripHtmlTags(addr.city.trim()),
    stateProvince: stateProvince ? stripHtmlTags(stateProvince) : null,
    postalCode: postalCode ? stripHtmlTags(postalCode) : null,
    country: stripHtmlTags(addr.country.trim().toUpperCase()),
  };
}

/** Sanitize a telecom number object by stripping HTML from all fields. */
export function sanitizeTelecomNumber(tel: {
  countryCode?: string | null;
  areaCode: string;
  lineNumber: string;
  extension?: string | null;
}, defaultCountryCode = "+1"): {
  countryCode: string;
  areaCode: string;
  lineNumber: string;
  extension: string | null;
} {
  const countryCode = tel.countryCode?.trim();
  const extension = tel.extension?.trim();
  return {
    countryCode: countryCode ? stripHtmlTags(countryCode) : defaultCountryCode,
    areaCode: stripHtmlTags((tel.areaCode ?? "").trim()),
    lineNumber: stripHtmlTags((tel.lineNumber ?? "").trim()),
    extension: extension ? stripHtmlTags(extension) : null,
  };
}
