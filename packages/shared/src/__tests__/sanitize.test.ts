import { describe, it, expect } from "vitest";
import { stripHtmlTags, sanitizeLogOutput, sanitizeForLog, safeFromCodePoint } from "../sanitize.js";

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

  it("throws on oversized input", () => {
    const long = "a".repeat(100_001);
    expect(() => stripHtmlTags(long)).toThrow("input too long");
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

  it("redacts file paths after 'at '", () => {
    expect(sanitizeLogOutput("at /home/user/project/src/file.ts:42")).toContain("[PATH]");
    expect(sanitizeLogOutput("at C:\\Users\\user\\src\\file.ts:1")).toContain("[PATH]");
  });

  it("preserves safe log messages", () => {
    expect(sanitizeLogOutput("User login successful")).toBe("User login successful");
    expect(sanitizeLogOutput("Party created: John Doe")).toBe("Party created: John Doe");
  });

  it("handles empty string", () => {
    expect(sanitizeLogOutput("")).toBe("");
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
});

describe("sanitizeForLog", () => {
  it("replaces newlines with underscores", () => {
    expect(sanitizeForLog("line1\nline2")).toBe("line1_line2");
    expect(sanitizeForLog("line1\r\nline2")).toBe("line1__line2");
  });

  it("replaces carriage returns with underscores", () => {
    expect(sanitizeForLog("line1\rline2")).toBe("line1_line2");
  });

  it("replaces tabs with underscores", () => {
    expect(sanitizeForLog("col1\tcol2")).toBe("col1_col2");
  });

  it("removes ANSI escape sequences", () => {
    expect(sanitizeForLog("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeForLog("\x1b[1mbold\x1b[22m")).toBe("bold");
  });

  it("replaces C0 control characters with underscores", () => {
    expect(sanitizeForLog("a\x00b\x01c")).toBe("a_b_c");
    expect(sanitizeForLog("hello\x7fworld")).toBe("hello_world");
  });

  it("preserves normal text", () => {
    expect(sanitizeForLog("hello world")).toBe("hello world");
    expect(sanitizeForLog("normal text with 123 numbers")).toBe("normal text with 123 numbers");
  });

  it("handles empty string", () => {
    expect(sanitizeForLog("")).toBe("");
  });

  it("strips multiple types of injection in one string", () => {
    const input = "msg\nwith\r\ttabs\x1b[33mand color";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\r");
    expect(result).not.toContain("\t");
    expect(result).not.toContain("\x1b[33m");
    expect(result).toContain("msg");
    expect(result).toContain("and color");
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
