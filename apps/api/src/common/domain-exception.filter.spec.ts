// Unit tests for the global DomainExceptionFilter.
//
// The filter is registered globally in AppModule and maps DomainError /
// HttpException / unexpected errors to JSON HTTP responses. It previously
// had no test coverage; these tests lock in its status-code mapping and the
// production response-scrubbing behavior (including the generic fallback
// message for ValidationPipe array messages).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpException, HttpStatus, type ArgumentsHost } from "@nestjs/common";
import type { Response } from "express";
import { DomainExceptionFilter } from "./domain-exception.filter.js";
import {
  DomainError,
  EntityNotFoundError,
  DuplicateEntityError,
  InvalidTypeValueError,
  TenantContextFailedError,
} from "@besterp/shared";

interface MockContext {
  host: ArgumentsHost;
  /** Mutated by the mock response as status()/json() are called. */
  captured: { sentStatus: number; body: unknown };
}

/** Build a fake ArgumentsHost whose response records status + body. */
function createMockHost(headersSent = false): MockContext {
  const captured = { sentStatus: 0, body: undefined as unknown };
  const response = {
    headersSent,
    status(code: number) {
      captured.sentStatus = code;
      return response;
    },
    json(payload: Record<string, unknown>) {
      captured.body = payload;
      return response;
    },
  } as unknown as Response;
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

describe("DomainExceptionFilter", () => {
  let originalNodeEnv: string | undefined;
  let filter: DomainExceptionFilter;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    filter = new DomainExceptionFilter();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe("DomainError mapping", () => {
    it.each([
      [new EntityNotFoundError("missing", { suggestedTools: ["search_parties"] }), 404],
      [new DuplicateEntityError("dup"), 409],
      [new InvalidTypeValueError("bad"), 422],
      [new TenantContextFailedError("rls-failed"), 503],
    ])("maps %s.constructor.name to the expected status", (error: DomainError, status: number) => {
      process.env.NODE_ENV = "development";
      const ctx = createMockHost();

      filter.catch(error, ctx.host);

      expect(ctx.captured.sentStatus).toBe(status);
      expect(ctx.captured.body).toMatchObject({
        statusCode: status,
        error: error.code,
        message: error.message,
      });
    });

    it("returns a generic message for unknown DomainError codes (500)", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      const error = new DomainError("TOTALLY_UNKNOWN_CODE", "boom");

      filter.catch(error, ctx.host);

      expect(ctx.captured.sentStatus).toBe(500);
      // Production replaces both the message and error code for unmapped 500
      // codes so no internal details leak to the client.
      expect(ctx.captured.body).toMatchObject({
        statusCode: 500,
        error: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      });
    });

    it("does not leak suggestedTools/context in production", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      const error = new EntityNotFoundError("missing", {
        suggestedTools: ["search_parties"],
        context: { partyId: "abc" },
      });

      filter.catch(error, ctx.host);

      expect(ctx.captured.body).not.toHaveProperty("suggestedTools");
      expect(ctx.captured.body).not.toHaveProperty("context");
    });

    it("sanitizes control characters embedded in the DomainError error code", () => {
      // The error code field is reflected to the client and must be sanitized
      // the same way the message field is — a custom DomainError could embed
      // control chars or ANSI in its code.
      process.env.NODE_ENV = "development";
      const ctx = createMockHost();
      const error = new DomainError(
        `INVALID\x1b[31mTEST\x1b[0m`,
        "boom"
      );

      filter.catch(error, ctx.host);

      const body = ctx.captured.body as Record<string, unknown>;
      expect((body.error as string)).not.toContain("\x1b");
      expect((body.error as string)).not.toContain("[31m");
      expect((body.error as string)).not.toContain("[0m");
    });

    it("sanitizes control characters embedded in the DomainError message", () => {
      // DomainError messages embed user input (invalidValue, received, etc.)
      // which is only .trim()'d upstream — interior newlines/tabs/ANSI survive.
      // The reflected response-body message must be sanitized to avoid
      // log/response injection, in both dev and production (non-500).
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      const error = new InvalidTypeValueError(
        `Invalid fromDate format: line1\nline2\t\x1b[31mFAKE\x1b[0m`
      );

      filter.catch(error, ctx.host);

      const body = ctx.captured.body as Record<string, unknown>;
      // newlines/tabs → "_", ANSI CSI escapes stripped.
      expect(body.message).toBe("Invalid fromDate format: line1_line2_FAKE");
      expect(JSON.stringify(body.message)).not.toContain("\\n");
      expect(JSON.stringify(body.message)).not.toContain("\\x1b");
    });

    it("recursively sanitizes string values inside nested context objects", () => {
      process.env.NODE_ENV = "development";
      const ctx = createMockHost();
      const error = new InvalidTypeValueError("bad", {
        context: {
          nested: { malicious: "a\nb\t\x1b[31mFAKE\x1b[0m" },
          list: ["ok", "x\ry"],
          count: 3,
        },
      });

      filter.catch(error, ctx.host);

      const body = ctx.captured.body as Record<string, unknown>;
      const context = body.context as Record<string, unknown>;
      const nested = context.nested as Record<string, unknown>;
      expect(nested.malicious).toBe("a_b_FAKE");
      expect(context.list).toEqual(["ok", "x_y"]);
      // primitives pass through unchanged.
      expect(context.count).toBe(3);
    });
  });

  describe("HttpException handling", () => {
    it("preserves field names and constraint descriptions but strips user values from array message in production", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      // ValidationPipe shapes message as an array of per-field detail strings.
      // The filter strips user-supplied values (quoted strings, "received:" suffixes)
      // while preserving the field name and constraint description.
      const error = new HttpException(
        { statusCode: 400, error: "Bad Request", message: [
          "name must be shorter than or equal to 500 characters",
          "partyType must be one of the following values: PERSON, ORGANIZATION",
          "email must be an email. Received: \"not-an-email\"",
        ] },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(error, ctx.host);

      expect(ctx.captured.sentStatus).toBe(400);
      const body = ctx.captured.body as Record<string, unknown>;
      expect(body.error).toBe("Bad Request");
      const messages = body.message as string[];
      // Constraint descriptions are preserved (no user values to strip).
      expect(messages[0]).toBe("name must be shorter than or equal to 500 characters");
      expect(messages[1]).toBe("partyType must be one of the following values: PERSON, ORGANIZATION");
      // "Received: ..." suffix is stripped.
      expect(messages[2]).toBe("email must be an email");
      expect(Array.isArray(messages)).toBe(true);
    });

    it("keeps a string message in production", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      const error = new HttpException(
        { statusCode: 403, error: "Forbidden", message: "You lack the required role" },
        HttpStatus.FORBIDDEN,
      );

      filter.catch(error, ctx.host);

      expect(ctx.captured.sentStatus).toBe(403);
      expect(ctx.captured.body).toMatchObject({
        statusCode: 403,
        error: "Forbidden",
        message: "You lack the required role",
      });
    });

    it("scrubs embedded secrets from a string HttpException message in production", () => {
      // Regression: round 43 sanitised the array-validation branch but left
      // the string message/error branches verbatim, so a custom
      // HttpException carrying a connection string / Bearer token in its
      // string message reached REST clients in production.
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      const error = new HttpException(
        {
          statusCode: 500,
          error: "postgres://user:secret@db:5432/app",
          message: "connect failed: postgres://user:secret@db:5432/app",
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

      filter.catch(error, ctx.host);

      expect(ctx.captured.sentStatus).toBe(500);
      const body = ctx.captured.body as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain("secret");
      expect(JSON.stringify(body)).not.toContain("postgres://user");
      expect((body.error as string)).toContain("[DATABASE_URL]");
      expect((body.message as string)).toContain("[DATABASE_URL]");
    });

    it("strips HTML tags from a string HttpException message in production", () => {
      // Regression: the HttpException string-message branch must apply the same
      // stripHtmlTags hardening as the DomainError path, otherwise a markup
      // payload (stored-XSS in any HTML renderer) reaches REST clients verbatim.
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      const error = new HttpException(
        { statusCode: 400, error: "BadInput", message: "<script>alert(1)</script><img src=x onerror=alert(2)>" },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(error, ctx.host);

      expect(ctx.captured.sentStatus).toBe(400);
      const body = ctx.captured.body as Record<string, unknown>;
      expect((body.message as string)).not.toContain("<script>");
      expect((body.message as string)).not.toContain("<img");
    });

    it("passes the full response through in non-production", () => {
      process.env.NODE_ENV = "development";
      const ctx = createMockHost();
      const error = new HttpException(
        { statusCode: 400, message: ["name must be a string"] },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(error, ctx.host);

      expect(ctx.captured.sentStatus).toBe(400);
      expect(ctx.captured.body).toEqual({ statusCode: 400, message: ["name must be a string"] });
    });
  });

  describe("unexpected errors", () => {
    it("returns a generic message in production", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();

      filter.catch(new Error("DB connection lost: postgres://user:pass@host"), ctx.host);

      expect(ctx.captured.sentStatus).toBe(500);
      expect(ctx.captured.body).toMatchObject({ statusCode: 500, message: "Internal server error" });
    });

    it("includes a sanitized message in development", () => {
      process.env.NODE_ENV = "development";
      const ctx = createMockHost();

      filter.catch(new Error("failed at postgresql://user:pass@db:5432/erp"), ctx.host);

      expect(ctx.captured.sentStatus).toBe(500);
      // sanitizeLogOutput redacts the connection string.
      expect(JSON.stringify(ctx.captured.body)).not.toContain("user:pass");
    });
  });

  describe("secret redaction in reflected message", () => {
    it("redacts connection strings embedded in the DomainError message in production", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      const error = new InvalidTypeValueError(
        `Invalid value: postgres://user:secretpw@db:5432/erp`
      );

      filter.catch(error, ctx.host);

      const body = ctx.captured.body as Record<string, unknown>;
      const message = body.message as string;
      // The connection string (credentials + host) must be redacted — matching
      // the MCP error-handler, which would have scrubbed the same message for
      // AI agents. Previously only HTML tags were stripped, leaking the secret.
      expect(message).not.toContain("secretpw");
      expect(message).not.toContain("postgres://");
      expect(message).toContain("[DATABASE_URL]");
    });

    it("redacts values under sensitive-named keys in dev context", () => {
      process.env.NODE_ENV = "development";
      const ctx = createMockHost();
      const error = new InvalidTypeValueError("bad", {
        context: { password: "hunter2", apiKey: "sk_live_x", name: "alice" },
      });

      filter.catch(error, ctx.host);

      const body = ctx.captured.body as Record<string, unknown>;
      const context = body.context as Record<string, unknown>;
      expect(context.password).toBe("[REDACTED]");
      expect(context.apiKey).toBe("[REDACTED]");
      expect(context.name).toBe("alice");
    });
  });

  describe("HttpException validation message secret redaction", () => {
    it("scrubs embedded secrets from array validation messages in production", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      // A custom validator may embed a bearer/secret token directly in the
      // message (not as a quoted "received:" value, which the strip step
      // removes). The message must still be scrubbed before it reaches the
      // REST client — matching how the MCP error-handler scrubs tokens for
      // AI agents.
      const error = new HttpException(
        { statusCode: 400, error: "Bad Request", message: [
          "auth header was Bearer sk_live_abc123xyz which is not valid",
        ] },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(error, ctx.host);

      const body = ctx.captured.body as Record<string, unknown>;
      const messages = body.message as string[];
      expect(messages[0]).not.toContain("sk_live_abc123xyz");
      expect(messages[0]).toContain("Bearer [REDACTED]");
    });
  });

  describe("headers already sent", () => {
    it("does not attempt to write a second response", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost(true);

      expect(() => filter.catch(new EntityNotFoundError("x"), ctx.host)).not.toThrow();
      expect(ctx.captured.sentStatus).toBe(0);
    });
  });
});
