import { describe, it, expect } from "vitest";
import { stripHtmlTags, sanitizeLogOutput, sanitizeLogMessage, sanitizeForLogOutput, safeFromCodePoint, isSensitiveFieldName, redactSensitiveFieldValues } from "../sanitize.js";
import { InvalidTypeValueError } from "../errors.js";

describe("stripHtmlTags", () => {
  it("returns empty string for empty input", () => {
    expect(stripHtmlTags("")).toBe("");
  });

  it("preserves plain text with no HTML", () => {
    expect(stripHtmlTags("hello world")).toBe("hello world");
    expect(stripHtmlTags("n0 v4l1d < > here")).toBe("n0 v4l1d < > here");
  });

  it("removes simple HTML tags", () => {
    expect(stripHtmlTags("<script>alert(1)</script>")).toBe("");
    expect(stripHtmlTags("<div>content</div>")).toBe("content");
    expect(stripHtmlTags("<p>hello</p> world")).toBe("hello world");
  });

  it("removes script and style content including tags", () => {
    expect(stripHtmlTags("<script>maliciousCode();</script>hello")).toBe("hello");
    expect(stripHtmlTags("<style>body{background:red}</style>text")).toBe("text");
  });

  it("removes nested/encoded HTML entities", () => {
    expect(stripHtmlTags("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("");
    expect(stripHtmlTags("&#60;script&#62;alert(1)&#60;/script&#62;")).toBe("");
  });

  it("removes double-encoded entities across iterations", () => {
    expect(stripHtmlTags("&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;")).toBe("");
  });

  it("removes HTML comments", () => {
    expect(stripHtmlTags("<!-- comment -->text")).toBe("text");
    expect(stripHtmlTags("before<!--[if IE]>IE conditional<![endif]-->after")).toBe("beforeafter");
  });

  it("strips null bytes", () => {
    expect(stripHtmlTags("hel\0lo")).toBe("hello");
  });

  it("removes orphaned opening tags", () => {
    expect(stripHtmlTags("<script malicious code here")).toBe("");
    expect(stripHtmlTags("<style")).toBe("");
  });

  it("handles deeply nested encoded strings with iteration cap", () => {
    const deepNested = "&amp;".repeat(5) + "lt;x&gt;";
    // After decoding all &amp; → & and stripping <x>, the leftover & chars remain
    expect(stripHtmlTags(deepNested)).toBe("&&&&");
  });

  it("throws InvalidTypeValueError on oversized input", () => {
    const long = "a".repeat(100_001);
    expect(() => stripHtmlTags(long)).toThrow(InvalidTypeValueError);
    expect(() => stripHtmlTags(long)).toThrow("input exceeds maximum");
  });

  it("throws InvalidTypeValueError on oversized multi-byte input (byte-length guard)", () => {
    // A 99k multi-byte string passes the UTF-16 code-unit count but is far
    // larger in UTF-8 bytes. The guard measures bytes, so it must reject.
    const longMultiByte = "中".repeat(99_000);
    expect(Buffer.byteLength(longMultiByte, "utf8")).toBeGreaterThan(100_000);
    expect(() => stripHtmlTags(longMultiByte)).toThrow(InvalidTypeValueError);
    expect(() => stripHtmlTags(longMultiByte)).toThrow("input exceeds maximum");
  });

  it("handles mixed content safely", () => {
    const result = stripHtmlTags("<b>hello</b> <script>evil</script> world");
    expect(result).toBe("hello  world");
  });

  it("handles special characters correctly", () => {
    expect(stripHtmlTags("&amp; &lt; &gt; &quot; &apos;")).toBe("& < > \" '");
    expect(stripHtmlTags("&amp;amp;lt;br /&amp;amp;gt;")).not.toContain("<br");
  });

  it("removes C0 control characters", () => {
    expect(stripHtmlTags("\x00\x01\x02test\x1f")).toBe("test");
    expect(stripHtmlTags("\x7fdel")).toBe("del");
  });

  it("normalizes &nbsp; to space", () => {
    expect(stripHtmlTags("hello&nbsp;world")).toBe("hello world");
  });

  it("removes incomplete HTML only after decoding", () => {
    expect(stripHtmlTags("&#x3C;script&#x3E;bad&#x3C;/script&#x3E;")).toBe("");
  });

  it("decodes uppercase &#X hex entity references (browser-compatible variant)", () => {
    // HTML5 spec accepts both &#x (lowercase) and &#X (uppercase) for
    // hex numeric character references. Both must decode to '<' and '>'
    // before tag stripping, otherwise stored texts like "&#X3C;script&#X3E;"
    // decode to actual tags when rendered in a browser (stored-XSS vector).
    expect(stripHtmlTags("&#X3C;script&#X3E;alert(1)&#X3C;/script&#X3E;")).toBe("");
    expect(stripHtmlTags("text &#X3C;b&#X3E;bold&#X3C;/b&#X3E; end")).toBe("text bold end");
  });
});

describe("sanitizeLogOutput", () => {
  it("redacts PostgreSQL connection strings", () => {
    expect(sanitizeLogOutput("postgres://user:pass@host:5432/db")).toContain("[DATABASE_URL]");
    expect(sanitizeLogOutput("postgresql://user@host/db")).toContain("[DATABASE_URL]");
  });

  it("redacts Redis connection strings", () => {
    expect(sanitizeLogOutput("redis://:password@host:6379")).toContain("[REDIS_URL]");
  });

  it("redacts MongoDB connection strings", () => {
    expect(sanitizeLogOutput("mongodb://user:pass@host:27017/db")).toContain("[DATABASE_URL]");
    expect(sanitizeLogOutput("mongodb+srv://user@host/db")).toContain("[DATABASE_URL]");
  });

  it("redacts MySQL connection strings", () => {
    expect(sanitizeLogOutput("mysql://user:pass@host:3306/db")).toContain("[DATABASE_URL]");
  });

  it("redacts AMQP connection strings", () => {
    expect(sanitizeLogOutput("amqp://user:pass@host:5672")).toContain("[MESSAGE_BROKER_URL]");
    expect(sanitizeLogOutput("amqps://user@host")).toContain("[MESSAGE_BROKER_URL]");
  });

  it("redacts protocol://HOST/ patterns", () => {
    expect(sanitizeLogOutput("https://internal.server.com/path")).toContain("[HOST]");
    expect(sanitizeLogOutput("http://10.0.0.1:8080/")).toContain("[HOST]");
  });

  it("redacts path and query string from generic HTTP URLs", () => {
    const result = sanitizeLogOutput("Error calling https://api.example.com/v1/users?token=secret&key=abc123");
    expect(result).toContain("[HOST]");
    expect(result).not.toContain("token=secret");
    expect(result).not.toContain("api.example.com");
  });

  it("redacts full URL when path contains sensitive data", () => {
    const result = sanitizeLogOutput("Failed at https://internal.admin/api/keys/sk-live-abc123");
    expect(result).toContain("[HOST]");
    expect(result).not.toContain("sk-live-abc123");
  });

  it("redacts file paths anchored by 'at '", () => {
    expect(sanitizeLogOutput("found at /home/user/project/src/file.ts:42")).toContain("[PATH]");
    expect(sanitizeLogOutput("found at C:\\Users\\user\\src\\file.ts:1")).toContain("[PATH]");
  });

  it("does NOT redact ordinary prose containing 'at /path'", () => {
    // A bare path at the end of a sentence with no file/extension/line suffix
    // is treated as prose and left intact.
    expect(sanitizeLogOutput("meet me at /home/user later")).toBe("meet me at /home/user later");
    expect(sanitizeLogOutput("retry at /admin/reindex now")).toBe("retry at /admin/reindex now");
  });

  it("redacts bare bearer tokens", () => {
    expect(sanitizeLogOutput("Authorization: Bearer sk_live_abc123xyz")).toContain("Bearer [REDACTED]");
    expect(sanitizeLogOutput("Authorization: Bearer sk_live_abc123xyz")).not.toContain("sk_live_abc123xyz");
  });

  it("redacts bare JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4f";
    const result = sanitizeLogOutput(`token ${jwt}`);
    expect(result).toContain("[REDACTED_JWT]");
    expect(result).not.toContain(jwt);
  });

  it("redacts secrets in query strings of non-credential HTTP URLs", () => {
    // Both query-string params carry secrets. The query-string rule redacts
    // each value; the trailing URL-collapse then folds the whole URL
    // (including the query string) into [HOST]/[PATH], so no secret survives
    // verbatim in the output.
    const result = sanitizeLogOutput("GET https://api.example.com/v1/charge?api_key=sk_live_abc123&token=xyz");
    expect(result).toContain("[HOST]");
    expect(result).not.toContain("sk_live_abc123");
    expect(result).not.toContain("xyz");
  });

  it("redacts a secret immediately followed by boundary punctuation ( ) ] }", () => {
    // The query-string secret rule previously stopped the capture at ) ] }
    // (e.g. a token inside a stack trace / curl snippet / JSON object), which
    // left the trailing boundary char behind and truncated the secret. The
    // value is now trimmed before [REDACTED] so the whole secret is scrubbed
    // and none of it survives in the collapsed URL.
    const r1 = sanitizeLogOutput("https://x.com/?token=sk_live_abc)");
    expect(r1).not.toContain("sk_live_abc");
    const r2 = sanitizeLogOutput("curl 'https://x.com/?token=sk_live_abc]'");
    expect(r2).not.toContain("sk_live_abc");
    const r3 = sanitizeLogOutput('{"url":"https://x.com/?token=sk_live_abc}"}');
    expect(r3).not.toContain("sk_live_abc");
  });

  it("redacts a secret wrapped in leading/trailing square brackets", () => {
    // The query-string secret rule captured `[` into the value class but only
    // trimmed TRAILING boundary punctuation, so `token=[sk_live_abc]` kept the
    // leading bracket and leaked the secret (the `]` boundary trimmed, but the
    // `[` survived and the secret between it and the leading `token=` leaked).
    // Leading `[` is now also trimmed before [REDACTED].
    const r = sanitizeLogOutput("https://x.com/?token=[sk_live_abc]");
    expect(r).not.toContain("sk_live_abc");
  });

  it("replaces (not annotates) the query-string secret value even without a URL", () => {
    // Regression guard (round 49): the query-string rule previously APPENDED
    // `[REDACTED]` after the secret value (`api_key=sk_live_abc123[REDACTED]`)
    // instead of replacing the value, so the secret survived verbatim in the
    // output. The surrounding `https://…→[HOST]/[PATH]` collapse hid this on
    // every existing URL-bearing test (the whole URL — secret included — was
    // folded away). But a secret-bearing query string with NO leading URL
    // (e.g. an agent-supplied `reasoning` carrying `?api_key=…`, a bare
    // curl-style arg, or a log line) was never collapsed and leaked the
    // secret. The value must be fully replaced.
    const r1 = sanitizeLogOutput("call via ?api_key=sk_live_abc123 done");
    expect(r1).not.toContain("sk_live_abc123");
    expect(r1).toContain("api_key=[REDACTED]");
    const r2 = sanitizeLogOutput("see ?token=supersecretvalue in log");
    expect(r2).not.toContain("supersecretvalue");
    expect(r2).toContain("token=[REDACTED]");
  });

  it("strips control characters and ANSI escapes even when called directly", () => {
    // sanitizeLogOutput composes the log-injection strip first, so a newline
    // injected into a credential-bearing message cannot forge log lines when
    // the function is used directly (not via sanitizeForLogOutput).
    const injected = "see postgres://u:p@h/db\n[REDACTED-LOGLINE]";
    const result = sanitizeLogOutput(injected);
    expect(result).toContain("[DATABASE_URL]");
    expect(result).not.toContain("\n");
    expect(result).not.toContain("[REDACTED-LOGLINE]");
    expect(result).toContain("_");
  });

  it("preserves safe log messages", () => {
    expect(sanitizeLogOutput("User login successful")).toBe("User login successful");
    expect(sanitizeLogOutput("Party created: John Doe")).toBe("Party created: John Doe");
  });

  it("handles empty string", () => {
    expect(sanitizeLogOutput("")).toBe("");
  });

  it("redacts protocol-only URL without trailing content", () => {
    // The regex requires at least one non-whitespace char after ://
    // to match. A bare "https://" with nothing after is not a valid
    // URL (no hostname), and a space after :// also means no hostname.
    // These should not crash or produce malformed replacements.
    expect(sanitizeLogOutput("https://")).toBe("https://");
    expect(sanitizeLogOutput("prefix https:// more")).toBe("prefix https:// more");
    // Sanity: a proper URL with hostname IS redacted
    expect(sanitizeLogOutput("https://host")).toContain("[HOST]");
  });

  it("redacts multiple patterns in one message", () => {
    const msg = "DB: postgres://u:p@h/db redis://h and at /path/to/file.ts";
    const result = sanitizeLogOutput(msg);
    expect(result).toContain("[DATABASE_URL]");
    expect(result).toContain("[REDIS_URL]");
    expect(result).toContain("[PATH]");
    expect(result).not.toContain("postgres://");
    expect(result).not.toContain("redis://");
  });

  it("redacts FTP connection strings", () => {
    expect(sanitizeLogOutput("ftp://user:pass@host:21/path")).toContain("[FTP_URL]");
    expect(sanitizeLogOutput("sftp://user@host/path")).toContain("[FTP_URL]");
  });

  it("redacts WebSocket connection strings", () => {
    expect(sanitizeLogOutput("ws://internal-host:8080/ws")).toContain("[WEBSOCKET_URL]");
    expect(sanitizeLogOutput("wss://secure-host/path")).toContain("[WEBSOCKET_URL]");
  });

  it("redacts credential-bearing URLs with unlisted schemes", () => {
    // Regression guard: the scheme-specific patterns only cover postgres,
    // redis, mongodb, mysql, amqp, http(s), ftp/sftp, and ws/wss. A driver or
    // library error can embed a credential-bearing URL in any other scheme
    // (ldap, ssh, vault, smtp, or a custom scheme). Without the generic
    // userinfo catch-all, `ssh://user:pass@host`, `ldap://cn=admin:password@host`,
    // and `vault://token:s3cret@host` passed through verbatim — leaking
    // credentials to operator logs.
    expect(sanitizeLogOutput("ssh://user:pass@host:22/path")).toBe("[REDACTED_URL]");
    expect(sanitizeLogOutput("ldap://cn=admin:password@ldap.host/dc=x")).toBe("[REDACTED_URL]");
    expect(sanitizeLogOutput("vault://token:s3cret@vault.svc:8200")).toBe("[REDACTED_URL]");
    expect(sanitizeLogOutput("ldaps://admin:secret@ldap.example.com")).toBe("[REDACTED_URL]");
    // Credentials in the middle of a sentence are still redacted.
    const result = sanitizeLogOutput("failed to connect via ssh://deploy:key@10.0.0.5 to deploy host");
    expect(result).not.toContain("deploy:key");
    expect(result).not.toContain("10.0.0.5");
    expect(result).toContain("[REDACTED_URL]");
  });

  it("leaves credential-free URLs of arbitrary schemes untouched", () => {
    // The generic catch-all only fires when a userinfo segment (user:pass@)
    // is present, so scheme-only URLs without credentials are not false
    // positives. `file:///etc/passwd` has no userinfo and must survive.
    expect(sanitizeLogOutput("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(sanitizeLogOutput("custom://host/path")).toBe("custom://host/path");
    // A scheme with just a bare host (no userinfo) is not credential-bearing.
    expect(sanitizeLogOutput("ssh://host")).toBe("ssh://host");
  });

  it("preserves labelled output for scheme-specific patterns over the generic catch-all", () => {
    // The generic pattern runs AFTER the scheme-specific ones, so a postgres
    // URL keeps its [DATABASE_URL] label rather than the generic
    // [REDACTED_URL].
    expect(sanitizeLogOutput("postgres://u:p@h/db")).toBe("[DATABASE_URL]");
    expect(sanitizeLogOutput("https://api.example.com/path")).toBe("https://[HOST]/[PATH]");
    expect(sanitizeLogOutput("redis://:password@host:6379")).toBe("[REDIS_URL]");
  });
});

describe("sanitizeLogMessage", () => {
  it("replaces newlines with underscores", () => {
    expect(sanitizeLogMessage("line1\nline2")).toBe("line1_line2");
    expect(sanitizeLogMessage("line1\r\nline2")).toBe("line1__line2");
  });

  it("replaces carriage returns with underscores", () => {
    expect(sanitizeLogMessage("line1\rline2")).toBe("line1_line2");
  });

  it("replaces tabs with underscores", () => {
    expect(sanitizeLogMessage("col1\tcol2")).toBe("col1_col2");
  });

  it("removes ANSI escape sequences", () => {
    expect(sanitizeLogMessage("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeLogMessage("\x1b[1mbold\x1b[22m")).toBe("bold");
  });

  it("replaces C0 control characters with underscores", () => {
    expect(sanitizeLogMessage("a\x00b\x01c")).toBe("a_b_c");
    expect(sanitizeLogMessage("hello\x7fworld")).toBe("hello_world");
  });

  it("preserves normal text", () => {
    expect(sanitizeLogMessage("hello world")).toBe("hello world");
    expect(sanitizeLogMessage("normal text with 123 numbers")).toBe("normal text with 123 numbers");
  });

  it("handles empty string", () => {
    expect(sanitizeLogMessage("")).toBe("");
  });

  it("strips multiple types of injection in one string", () => {
    const input = "msg\nwith\r\ttabs\x1b[33mand color";
    const result = sanitizeLogMessage(input);
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\r");
    expect(result).not.toContain("\t");
    expect(result).not.toContain("\x1b[33m");
    expect(result).toContain("msg");
    expect(result).toContain("and color");
  });

  it("strips OSC sequences (ESC ] ... ST/BEL)", () => {
    expect(sanitizeLogMessage("\x1b]0;MyTitle\x07content")).toBe("content");
    expect(sanitizeLogMessage("\x1b]2;NewTitle\x1b\\text")).toBe("text");
  });

  it("strips APC sequences (ESC _ ... ST/BEL)", () => {
    expect(sanitizeLogMessage("\x1b_application command\x07data")).toBe("data");
    expect(sanitizeLogMessage("\x1b_cmd\x1b\\rest")).toBe("rest");
  });

  it("strips SOS sequences (ESC X ... ST/BEL)", () => {
    expect(sanitizeLogMessage("\x1bXstring start\x07output")).toBe("output");
    expect(sanitizeLogMessage("\x1bXdata\x1b\\end")).toBe("end");
  });

  it("strips PM sequences (ESC ^ ... ST/BEL)", () => {
    expect(sanitizeLogMessage("\x1b^privacy\x07message")).toBe("message");
    expect(sanitizeLogMessage("\x1b^data\x1b\\final")).toBe("final");
  });

  it("strips DCS sequences (ESC P ... ST/BEL)", () => {
    expect(sanitizeLogMessage("\x1bPdevice control\x07output")).toBe("output");
    expect(sanitizeLogMessage("\x1bPparams;data\x1b\\rest")).toBe("rest");
    expect(sanitizeLogMessage("a\x1bP\x1b\\b")).toBe("ab");
  });

  it("strips non-CSI escape sequences (ESC + single char)", () => {
    expect(sanitizeLogMessage("\x1bMtext")).toBe("text");
    expect(sanitizeLogMessage("\x1b7before\x1b8after")).toBe("beforeafter");
    expect(sanitizeLogMessage("\x1bDa\x1bEb")).toBe("ab");
    expect(sanitizeLogMessage("\x1b=\x1b>")).toBe("");
    expect(sanitizeLogMessage("\x1b0\x1b1\x1b2\x1b3\x1b4\x1b5\x1b6\x1b7\x1b8\x1b9")).toBe("");
    expect(sanitizeLogMessage("\x1b2before\x1b5after")).toBe("beforeafter");
  });

  it("strips non-CSI escapes with BACKSLASH final byte (ESC \\ = ST, String Terminator)", () => {
    // 0x5C (backslash) is a valid ECMA-48 two-character final byte used as
    // the String Terminator. Without it in the regex, the trailing \ survives
    // as a stray character after the ESC byte is replaced by the control-char pass.
    expect(sanitizeLogMessage("\x1b\\")).toBe("");
    expect(sanitizeLogMessage("\x1b\\")).not.toBe("_\\");
    expect(sanitizeLogMessage("a\x1b\\b")).toBe("ab");
    expect(sanitizeLogMessage("\x1b\\more")).toBe("more");
  });

  it("strips non-CSI escapes with LOWERCASE final bytes (ESC c=RIS, ESC n=LS2, ESC o=LS3)", () => {
    // Lowercase finals are valid two-char ESC sequences. The ESC initiator
    // is always neutralized by the control-char pass, but without the
    // lowercase class entry the trailing final byte survived as a stray
    // character (e.g. "\x1bc" → "_c"). These now strip cleanly to "".
    expect(sanitizeLogMessage("\x1bcreset")).toBe("reset");
    expect(sanitizeLogMessage("a\x1bnb")).toBe("ab");
    expect(sanitizeLogMessage("a\x1bob")).toBe("ab");
    expect(sanitizeLogMessage("\x1bc\x1bn\x1bo")).toBe("");
    // Regression guard: an isolated ESC followed by a lowercase final must
    // not leave a stray underscore+letter (the old broken behaviour).
    expect(sanitizeLogMessage("\x1bc")).toBe("");
    expect(sanitizeLogMessage("\x1bc")).not.toBe("_c");
  });

  it("strips non-CSI escapes with intermediate bytes (ESC I...I F)", () => {
    // Sequences like ESC ( B (select character set) have intermediate bytes
    // between ESC and the final byte. These were only partially stripped by
    // the two-char regex, leaving stray characters like "_(B".
    expect(sanitizeLogMessage("\x1b(Btext")).toBe("text");
    expect(sanitizeLogMessage("a\x1b)Bb")).toBe("ab");
    expect(sanitizeLogMessage("a\x1b*Bb")).toBe("ab");
    expect(sanitizeLogMessage("a\x1b+Bb")).toBe("ab");
    expect(sanitizeLogMessage("a\x1b-Bb")).toBe("ab");
    expect(sanitizeLogMessage("\x1b(B\x1b)B")).toBe("");
    // Two intermediate bytes (e.g. ESC $ ( C for Korean charset)
    expect(sanitizeLogMessage("\x1b$(Ctext")).toBe("text");
    // Regression: isolated intermediate byte without final byte should not
    // cause false match — ESC + single intermediate byte alone is not a
    // complete sequence and should leave the intermediate byte.
    expect(sanitizeLogMessage("\x1b(")).not.toBe("");
    expect(sanitizeLogMessage("\x1b(")).toBe("_(");
  });

  it("strips C1 control characters (U+0080-U+009F)", () => {
    // C1 controls like U+009B (CSI) can be used as an alternative to ESC+[
    // for ANSI escape sequences. These must be stripped to prevent
    // terminal injection bypassing the ESC-based removal patterns.
    expect(sanitizeLogMessage("a\u009Bb")).toBe("a_b");
    expect(sanitizeLogMessage("a\u0090b")).toBe("a_b");
    expect(sanitizeLogMessage("a\u009Fb")).toBe("a_b");
    expect(sanitizeLogMessage("\u0080\u0090\u009Etext")).toBe("___text");
  });

  it("strips mixed ANSI sequences correctly", () => {
    const input = "\x1b[31mred\x1b]0;title\x07\x1bMmid\x1b_apc\x1b\\end";
    const result = sanitizeLogMessage(input);
    expect(result).toBe("redmidend");
  });

  it("preserves text with no ANSI sequences", () => {
    expect(sanitizeLogMessage("normal plain text")).toBe("normal plain text");
  });

  it("handles isolated ESC byte at end of string", () => {
    // A lone \x1b at the end is not a valid ANSI sequence (no final byte).
    // The non-CSI regex requires at least one intermediate or final byte after
    // ESC. The \x1b falls through to the control-char replacement pass.
    expect(sanitizeLogMessage("end\x1b")).toBe("end_");
    expect(sanitizeLogMessage("\x1b")).toBe("_");
  });

  it("strips CSI sequences with non-digit parameter bytes (?, <, =, >)", () => {
    // ECMA-48 allows parameter bytes in the range 0x30–0x3F (digits + : ; < = > ?).
    // The old regex [0-9;] missed < = > ?, so sequences like ESC [ ? 2 5 h
    // (show cursor) and ESC [ ? 2 5 l (hide cursor) left stray chars after the
    // ESC was replaced by the control-char pass. The fixed regex uses \x30-\x3F.
    expect(sanitizeLogMessage("\x1b[?25h")).toBe("");
    expect(sanitizeLogMessage("\x1b[?25l")).toBe("");
    expect(sanitizeLogMessage("\x1b[?1049h")).toBe("");
    expect(sanitizeLogMessage("\x1b[?1049l")).toBe("");
    expect(sanitizeLogMessage("a\x1b[?25hb")).toBe("ab");
    // Sequences with '>' (0x3E) parameter prefix (e.g. DEC private set/reset)
    expect(sanitizeLogMessage("\x1b[>1;2c")).toBe("");
    // Non-parameter '<' is a valid private CSI final byte
    expect(sanitizeLogMessage("\x1b[<5;10m")).toBe("");
  });
});

describe("sanitizeForLogOutput", () => {
  it("composes sanitizeLogMessage and sanitizeLogOutput", () => {
    const input = "msg\nwith\r\tansi\x1b[31mcolor\x1b[0m and postgres://user:pass@host/db";
    const result = sanitizeForLogOutput(input);
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\r");
    expect(result).not.toContain("\t");
    expect(result).not.toContain("\x1b[31m");
    expect(result).not.toContain("postgres://");
    expect(result).toContain("[DATABASE_URL]");
    expect(result).toContain("msg");
    expect(result).toContain("and");
  });

  it("redacts URLs after stripping control chars", () => {
    const result = sanitizeForLogOutput("error at https://internal.server.com/path?token=secret");
    expect(result).toContain("[HOST]");
    expect(result).not.toContain("token=secret");
    expect(result).not.toContain("\n");
  });

  it("handles empty string", () => {
    expect(sanitizeForLogOutput("")).toBe("");
  });

  it("preserves safe messages", () => {
    expect(sanitizeForLogOutput("User login successful")).toBe("User login successful");
  });

  it("handles ANSI-only input", () => {
    expect(sanitizeForLogOutput("\x1b[31m\x1b[0m")).toBe("");
  });

  it("does not catastrophically backtrack on long letter runs (ReDoS)", () => {
    // Regression guard (round 48): the generic `scheme://user:pass@host`
    // catch-all had an unbounded greedy scheme prefix
    // (`[a-zA-Z][a-zA-Z0-9+.-]*`), which backtracked O(n²) on a long run of
    // letters with no `://` — a 100k-char input blocked the event loop for
    // ~7s. The scheme length is now capped ({1,31}) and the input is length-
    // bounded, so sanitization of a huge attacker-controlled message stays
    // linear and returns quickly.
    const input = "x".repeat(100_000);
    const start = performance.now();
    const result = sanitizeForLogOutput(input);
    const elapsed = performance.now() - start;
    expect(result).toBe(input);
    expect(elapsed).toBeLessThan(500);
  });

  it("redacts a credential-bearing URL even with a 31+ char scheme", () => {
    // The scheme-length cap must not suppress legitimate (short) credential
    // URLs. A normal ssh/ldap/vault URL must still be redacted.
    expect(sanitizeForLogOutput("ssh://user:pass@host:22/path")).toContain("[REDACTED_URL]");
    expect(sanitizeForLogOutput("ldap://cn=admin:password@ldap.host/dc=x")).toContain("[REDACTED_URL]");
  });
});

describe("safeFromCodePoint", () => {
  it("returns character for valid code points", () => {
    expect(safeFromCodePoint(65)).toBe("A");
    expect(safeFromCodePoint(0x1f600)).toBe("😀");
    expect(safeFromCodePoint(32)).toBe(" ");
  });

  it("returns replacement character for lone surrogates", () => {
    const result = safeFromCodePoint(0xD800);
    expect(result).toBe("\uFFFD");
  });

  it("returns replacement character for negative values", () => {
    expect(safeFromCodePoint(-1)).toBe("\uFFFD");
  });

  it("returns replacement character for out-of-range values", () => {
    expect(safeFromCodePoint(0x110000)).toBe("\uFFFD");
  });

  it("returns replacement character for NaN", () => {
    expect(safeFromCodePoint(NaN)).toBe("\uFFFD");
  });
});

describe("sanitizeLogOutput — broadened query-string secret params", () => {
  it("redacts pwd/passwd query params", () => {
    const r = sanitizeLogOutput("https://x.com/login?pwd=hunter2&passwd=secret");
    expect(r).not.toContain("hunter2");
    expect(r).not.toContain("secret");
  });

  it("redacts signature/sign/otp/code/session query params", () => {
    const r = sanitizeLogOutput("https://x.com/sign?signature=sig123&sign=s&otp=123456&code=abc&session=ses_xyz");
    expect(r).not.toContain("sig123");
    expect(r).not.toContain("123456");
    expect(r).not.toContain("ses_xyz");
  });

  it("redacts client_id query param", () => {
    const r = sanitizeLogOutput("https://x.com/oauth?client_id=client_secret_value");
    expect(r).not.toContain("client_secret_value");
  });
});

describe("isSensitiveFieldName", () => {
  it("detects common sensitive field names", () => {
    for (const k of ["password", "apiKey", "api_key", "secret", "token", "clientSecret", "accessToken", "newPassword", "user_passphrase"]) {
      expect(isSensitiveFieldName(k)).toBe(true);
    }
  });

  it("does NOT flag benign key-bearing names", () => {
    for (const k of ["primaryKey", "foreignKey", "sortKey", "statusCode", "name", "email", "partyId"]) {
      expect(isSensitiveFieldName(k)).toBe(false);
    }
  });
});

describe("redactSensitiveFieldValues", () => {
  it("redacts values under sensitive-named keys at any depth", () => {
    const input = { user: { password: "hunter2", name: "alice" }, token: "sk_live_x" };
    const out = redactSensitiveFieldValues(input) as Record<string, unknown>;
    expect(out.user).toEqual({ password: "[REDACTED]", name: "alice" });
    expect(out.token).toBe("[REDACTED]");
  });

  it("redacts secrets embedded in string leaves", () => {
    const out = redactSensitiveFieldValues({ note: "see postgres://user:pass@db" }) as Record<string, unknown>;
    expect((out.note as string)).toContain("[DATABASE_URL]");
  });

  it("guards against circular references", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const out = redactSensitiveFieldValues(obj) as Record<string, unknown>;
    expect(out.self).toBe("[Circular]");
  });

  it("redacts sensitive-named Map keys and preserves the data (not {} )", () => {
    // Regression: the canonical redactor must handle Map/Set (converting them
    // to JSON-safe arrays) and redact sensitive-named keys — a Map passed to
    // the REST dev-context reflection path was previously serialised as {} and
    // its secret under a sensitive key leaked on the MCP surface but not here.
    const input = { m: new Map([["password", "hunter2"]]) };
    const out = redactSensitiveFieldValues(input) as Record<string, unknown>;
    expect(out.m).toEqual([["[REDACTED]", "[REDACTED]"]]);
  });

  it("converts plain Map/Set values to JSON-safe arrays", () => {
    const input = { m: new Map([["k", "v"]]), s: new Set([1, 2]) };
    const out = redactSensitiveFieldValues(input) as Record<string, unknown>;
    expect(out.m).toEqual([["k", "v"]]);
    expect(out.s).toEqual([1, 2]);
  });

  it("stops descending and returns a placeholder past the depth cap", () => {
    // Regression: no depth guard meant a deeply nested attacker-controlled
    // context could blow the stack on the REST dev-reflection path. Use a
    // non-sensitive key so the value is actually traversed (a sensitive key
    // short-circuits to "[REDACTED]" before descending). The traversal stops
    // at MAX_REDACTION_DEPTH and emits "[Too deep]" rather than recursing
    // unbounded, so the leaf value is never reached.
    let deep: Record<string, unknown> = { leaf: "v" };
    for (let i = 0; i < 50; i++) deep = { child: deep };
    const out = redactSensitiveFieldValues({ payload: deep }) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain("[Too deep]");
    expect(JSON.stringify(out)).not.toContain("leaf");
  });
});
