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
  DomainError, isDomainError, getErrorCode, sanitizeForLogOutput, sanitizeLogMessage,
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
 * tool or API client. Non-string values pass through unchanged.
 */
function sanitizeContext(context: Record<string, ContextValue>): Record<string, ContextValue> {
  const sanitized: Record<string, ContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string") {
      sanitized[key] = sanitizeLogMessage(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((v) => typeof v === "string" ? sanitizeLogMessage(v) : v);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
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
        `Unknown DomainError code '${exception.code}' — add a mapping in domainErrorToStatus(). Defaulting to 500. Context: ${sanitizeForLogOutput(JSON.stringify(exception.context))}. Suggested tools: ${JSON.stringify(exception.suggestedTools)}.`
      );
    } else {
      this.logger.warn(
        `DomainError [${exception.code}]: ${sanitizeForLogOutput(exception.message)}`
      );
    }

    const isDev = process.env.NODE_ENV === "development";
    const isProd = process.env.NODE_ENV === "production";
    const body: Record<string, unknown> = {
      statusCode: status,
      error: exception.code,
      ...(status === 500 && isProd
        ? { message: "An unexpected error occurred" }
        : { message: exception.message }),
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

    // In production, strip any internal details from HttpException responses.
    // Some NestJS exceptions (e.g., ValidationPipe errors) include the full
    // validation error array, which could leak internal field names or logic.
    if (process.env.NODE_ENV === "production" && typeof exceptionResponse === "object" && exceptionResponse !== null) {
      const res = exceptionResponse as Record<string, unknown>;
      // Keep only safe, client-facing fields; drop validation details, stack, etc.
      const safeBody: Record<string, unknown> = { statusCode: status };
      if (typeof res.message === "string") {
        safeBody.message = res.message;
      } else if (Array.isArray(res.message)) {
        // ValidationPipe errors carry an array of per-field detail strings.
        // Strip any embedded values that could leak internal state but
        // preserve the field names so clients can fix their requests.
        const cleaned: string[] = res.message
          .map((m) => (typeof m === "string" ? m.replace(/ .*$/, "") : "Validation error"))
          .filter(Boolean);
        safeBody.message = cleaned.length > 0
          ? cleaned
          : (status === 400 ? "Validation failed" : "Request error");
      } else {
        safeBody.message = status === 400 ? "Validation failed" : "Request error";
      }
      if (typeof res.error === "string") safeBody.error = res.error;
      response.status(status).json(safeBody);
      return;
    }

    response.status(status).json(
      typeof exceptionResponse === "string"
        ? { statusCode: status, message: exceptionResponse }
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
      ? sanitizeForLogOutput(exception.message)
      : "Internal server error";
    response.status(500).json({
      statusCode: 500,
      error: "INTERNAL_ERROR",
      message: responseMessage,
    });
  }
}
