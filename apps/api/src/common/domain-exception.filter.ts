// Global Domain Exception Filter — Maps DomainError subclasses to HTTP responses.
//
// Catches any thrown DomainError (EntityNotFoundError, InvalidTypeValueError, etc.)
// and returns a structured JSON response with the correct HTTP status code.
//
// This filter is registered globally in AppModule so that REST controllers
// automatically return proper status codes for domain errors. MCP tools use
// the errorHandlerMiddleware instead (different error format for AI agents).
//
// Response shape:
//   { statusCode, error: "CODE", message, suggestedTools, context }

import { ExceptionFilter, Catch, ArgumentsHost, Logger, HttpException } from "@nestjs/common";
import type { Response } from "express";
import {
  DomainError, isDomainError, getErrorCode, sanitizeForLogOutput,
  stripHtmlTags, redactSensitiveFieldValues,
  EntityNotFoundError, DuplicateEntityError, ConcurrencyConflictError,
  MissingSubtypeDataError, InvalidTypeValueError, InvalidTenantIdError,
  TenantContextFailedError,
  type ContextValue,
} from "@besterp/shared";

/**
 * Map a DomainError code to an HTTP status code.
 */
function domainErrorToStatus(error: DomainError): number {
  switch (error.code) {
    case EntityNotFoundError.CODE:
      return 404;
    case DuplicateEntityError.CODE:
    case ConcurrencyConflictError.CODE:
      return 409;
    case InvalidTenantIdError.CODE:
    case MissingSubtypeDataError.CODE:
    case InvalidTypeValueError.CODE:
      return 422;
    case TenantContextFailedError.CODE: // used by rls-extension
      return 503;
    default:
      return 500;
  }
}

/**
 * Sanitize DomainError.context values before including them in HTTP responses.
 * Strips control characters (newlines, tabs, ANSI escapes) from string values
 * to prevent log injection if the response body is ever logged by a monitoring
 * tool or API client, redacts values stored under sensitive-named keys
 * (password, apiKey, …) so a secret attached under a sensitive-named context
 * key reaches REST dev clients as "[REDACTED]" — matching the key-based
 * redaction the MCP error-handler applies to the same DomainError.context for
 * AI agents — and guards against container cycles.
 */
function sanitizeContext(context: Record<string, ContextValue>): Record<string, ContextValue> {
  // Redact the whole context tree at once so key-based redaction can see the
  // field names (a per-entry walk would lose the key by the time the value
  // reached the redactor). redactSensitiveFieldValues sanitizes every string
  // leaf and redacts values under sensitive-named keys, and guards cycles.
  return redactSensitiveFieldValues(context) as Record<string, ContextValue>;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      this.logger.warn(
        `Headers already sent — cannot write error response. Exception: ${sanitizeForLogOutput(exception instanceof Error ? exception.message : String(exception))}`
      );
      return;
    }

    if (isDomainError(exception)) {
      this.handleDomainError(exception, response);
      return;
    }

    if (exception instanceof HttpException) {
      this.handleHttpException(exception, response);
      return;
    }

    this.handleUnexpectedError(exception, response);
  }

  private handleDomainError(exception: DomainError, response: Response): void {
    const status = domainErrorToStatus(exception);
    if (status === 500) {
      this.logger.error(
        `Unknown DomainError code '${exception.code}' — add a mapping in domainErrorToStatus(). Context: ${sanitizeForLogOutput(JSON.stringify(redactSensitiveFieldValues(exception.context)))}. Suggested tools: ${JSON.stringify(exception.suggestedTools)}.`
      );
    } else {
      this.logger.warn(
        `DomainError [${exception.code}]: ${sanitizeForLogOutput(exception.message)}`
      );
    }

    const isDev = process.env.NODE_ENV === "development";
    const body: Record<string, unknown> = {
      statusCode: status,
      error: exception.code,
      // DomainError messages frequently embed user-supplied input (invalid
      // values, received fields, malformed dates), e.g.
      //   `Invalid fromDate format: ${trimmed}.`
      //   `${field} is not a valid ISO 8601 date. Received: ${value}.`
      // Those values are only .trim()'d upstream, so interior control chars
      // (newlines, tabs, ANSI escapes), raw HTML/scripts, AND sensitive
      // connection strings / tokens (e.g. a `postgres://user:pass@…` echoed
      // via a downstream error, or a `Bearer …` token) survive into the
      // message. Reflecting the message verbatim into the response body
      // re-opens the same log/response-injection surface that
      // sanitizeContext() closes for context values — and unlike context this
      // field is sent in BOTH dev and production for non-500 DomainErrors.
      // sanitizeForLogOutput runs control-char/ANSI stripping FIRST and then
      // redacts URLs/secrets/tokens (matching the MCP error-handler), and
      // stripHtmlTags last for stored-XSS defense. This keeps the existing
      // "_"-substitution + HTML-strip semantics while closing the
      // secret-disclosure gap that the parallel MCP surface did not have.
      ...(status === 500 && !isDev
        ? { message: "An unexpected error occurred" }
        : { message: stripHtmlTags(sanitizeForLogOutput(exception.message)) }),
    };
    if (isDev && exception.suggestedTools.length > 0) {
      body.suggestedTools = exception.suggestedTools;
    }
    if (isDev && Object.keys(exception.context).length > 0) {
      body.context = sanitizeContext(exception.context);
    }
    response.status(status).json(body);
  }

  private handleHttpException(exception: HttpException, response: Response): void {
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    // Strip internal details from HttpException responses in every environment
    // EXCEPT development. Some NestJS exceptions (e.g., ValidationPipe errors)
    // include the full validation error array, which could leak internal
    // field names or logic. Production hardening must NOT depend on an exact
    // "production" NODE_ENV: staging / preview / uat deployments that run under
    // any other value would otherwise return raw error bodies (information
    // disclosure). Only the explicit development environment is permissive.
    const isDev = process.env.NODE_ENV === "development";
    if (!isDev && typeof exceptionResponse === "object" && exceptionResponse !== null) {
      const res = exceptionResponse as Record<string, unknown>;
      // Keep only safe, client-facing fields; drop validation details, stack, etc.
      const safeBody: Record<string, unknown> = { statusCode: status };
      if (typeof res.message === "string") {
        // A custom/upstream HttpException may carry a secret-shaped value
        // (connection string, Bearer token, ?token=…) directly in its string
        // message. Scrub it the same way the array-validation branch and the
        // DomainError path do, so a REST client cannot extract a secret that
        // an AI agent would not see.
        safeBody.message = stripHtmlTags(sanitizeForLogOutput(res.message));
      } else if (Array.isArray(res.message)) {
        // ValidationPipe errors carry an array of per-field detail strings
        // like "field must be shorter than or equal to 500 characters" or
        // "field must be an enum value". Strip user-supplied values (the
        // last quoted token or trailing received value) while preserving the
        // field name and constraint description so clients know which field
        // failed and why.
        const cleaned: string[] = res.message
          .map((m) => {
            if (typeof m !== "string") return "Validation error";
            const stripped = m
              .replace(/\s*received\s*:\s*"[^"]*"\s*$/i, "")
              .replace(/\s*"[^"]*"\s*$/, "")
              .replace(/[.,;:]\s*$/, "")
              .trim() || m.split(" ")[0] || "Validation error";
            // A custom validator may embed a connection-string/secret-shaped
            // value directly in the message. Scrub it the same way the MCP
            // error-handler scrubs agent-facing errors so a REST client cannot
            // extract a secret that an AI agent would not see.
            return sanitizeForLogOutput(stripped);
          })
          .filter(Boolean);
        safeBody.message = cleaned.length > 0
          ? cleaned
          : (status === 400 ? "Validation failed" : "Request error");
      } else {
        safeBody.message = status === 400 ? "Validation failed" : "Request error";
      }
      if (typeof res.error === "string") safeBody.error = stripHtmlTags(sanitizeForLogOutput(res.error));
      response.status(status).json(safeBody);
      return;
    }

    response.status(status).json(
      typeof exceptionResponse === "string"
        ? { statusCode: status, message: stripHtmlTags(sanitizeForLogOutput(exceptionResponse)) }
        : exceptionResponse
    );
  }

  private handleUnexpectedError(exception: unknown, response: Response): void {
    const errorCode = getErrorCode(exception);
    const description = exception instanceof Error
      ? exception.message
      : (() => {
          try { return JSON.stringify(exception); } catch { return String(exception); }
        })();
    this.logger.error(
      `Unhandled exception${errorCode ? ` [${errorCode}]` : ""}: ${sanitizeForLogOutput(description)}`,
      exception instanceof Error && exception.stack ? sanitizeForLogOutput(exception.stack) : undefined
    );
    const isDev = process.env.NODE_ENV === "development";
    const responseMessage = isDev && exception instanceof Error
      ? stripHtmlTags(sanitizeForLogOutput(exception.message))
          // Strip internal file paths that could leak implementation details.
          // A Prisma/driver error message may embed an absolute path like
          // `/opt/app/node_modules/@prisma/client/runtime/edge.js` which aids
          // an attacker in fingerprinting the deployment. Collapse to [PATH].
          .replace(/(?:\/(?:[^\s"']+\/)*)([^\s"']+\.(?:js|ts))/g, "[PATH]")
      : "Internal server error";
    response.status(500).json({
      statusCode: 500,
      error: "INTERNAL_ERROR",
      message: responseMessage,
    });
  }
}
