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
      // Production replaces the internal message for unmapped 500 codes.
      expect(ctx.captured.body).toMatchObject({
        statusCode: 500,
        error: "TOTALLY_UNKNOWN_CODE",
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
  });

  describe("HttpException handling", () => {
    it("scrubs array message into a generic 'Validation failed' in production", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost();
      // ValidationPipe shapes message as an array of detail strings.
      const error = new HttpException(
        { statusCode: 400, error: "Bad Request", message: ["name must be a string", "partyType must be an enum"] },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(error, ctx.host);

      expect(ctx.captured.sentStatus).toBe(400);
      expect(ctx.captured.body).toMatchObject({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
      });
      // No validation detail array leaked.
      expect(Array.isArray((ctx.captured.body as Record<string, unknown>).message)).toBe(false);
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

  describe("headers already sent", () => {
    it("does not attempt to write a second response", () => {
      process.env.NODE_ENV = "production";
      const ctx = createMockHost(true);

      expect(() => filter.catch(new EntityNotFoundError("x"), ctx.host)).not.toThrow();
      expect(ctx.captured.sentStatus).toBe(0);
    });
  });
});
