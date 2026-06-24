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
import { DomainError, isDomainError, getErrorCode, sanitizeLogOutput } from "@besterp/shared";

/**
 * Map a DomainError code to an HTTP status code.
 */
function domainErrorToStatus(error: DomainError): number {
  switch (error.code) {
    case "ENTITY_NOT_FOUND":
      return 404;
    case "DUPLICATE_ENTITY":
      return 409;
    case "CONCURRENCY_CONFLICT":
      return 409;
    case "INVALID_TENANT_ID":
    case "MISSING_SUBTYPE_DATA":
    case "INVALID_TYPE_VALUE":
      return 422;
    case "TENANT_CONTEXT_FAILED":
      return 503;
    default:
      return 500;
  }
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      this.logger.warn(
        `Headers already sent — cannot write error response. Exception: ${exception instanceof Error ? exception.message : String(exception)}`
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
      this.logger.warn(
        `Unknown DomainError code '${exception.code}' — add a mapping in domainErrorToStatus(). Defaulting to 500.`
      );
    } else {
      this.logger.warn(
        `DomainError [${exception.code}]: ${exception.message}`
      );
    }

    const isProd = process.env.NODE_ENV === "production";
    response.status(status).json({
      statusCode: status,
      ...(isProd ? {} : { error: exception.code }),
      ...(status === 500 && isProd
        ? { message: "An unexpected error occurred" }
        : { message: exception.message }),
    });
  }

  private handleHttpException(exception: HttpException, response: Response): void {
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    response.status(status).json(
      typeof exceptionResponse === "string"
        ? { statusCode: status, message: exceptionResponse }
        : exceptionResponse
    );
  }

  private handleUnexpectedError(exception: unknown, response: Response): void {
    const errorCode = getErrorCode(exception);
    this.logger.error(
      `Unhandled exception${errorCode ? ` [${errorCode}]` : ""}: ${exception instanceof Error ? exception.message : exception}`,
      exception instanceof Error ? exception.stack : undefined
    );
    const isDev = process.env.NODE_ENV === "development";
    // In development, include the (sanitized) error message to aid debugging.
    // In all other environments, return a safe generic message.
    const responseMessage = isDev && exception instanceof Error
      ? sanitizeLogOutput(exception.message)
      : "Internal server error";
    response.status(500).json({
      statusCode: 500,
      message: responseMessage,
    });
  }
}
