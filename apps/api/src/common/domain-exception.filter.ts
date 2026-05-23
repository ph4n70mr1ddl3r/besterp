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
import { Response } from "express";
import { DomainError, isDomainError } from "@besterp/shared";

/**
 * Map a DomainError code to an HTTP status code.
 */
function domainErrorToStatus(error: DomainError): number {
  switch (error.code) {
    case "ENTITY_NOT_FOUND":
      return 404;
    case "DUPLICATE_ENTITY":
    case "DUPLICATE_ROLE":
      return 409;
    case "MISSING_SUBTYPE_DATA":
    case "INVALID_TYPE_VALUE":
      return 422;
    case "CONCURRENCY_CONFLICT":
      return 409;
    default:
      return 422;
  }
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      return;
    }

    if (isDomainError(exception)) {
      const status = domainErrorToStatus(exception);
      this.logger.warn(
        `DomainError [${exception.code}]: ${exception.message}`
      );

      response.status(status).json({
        statusCode: status,
        error: exception.code,
        message: exception.message,
        suggestedTools: exception.suggestedTools.length > 0
          ? exception.suggestedTools
          : undefined,
        context: Object.keys(exception.context).length > 0
          ? exception.context
          : undefined,
      });
      return;
    }

    // Pass through NestJS HttpExceptions (NotFoundException, BadRequestException, etc.)
    // so that the default NestJS exception filter can handle them.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      response.status(status).json(
        typeof exceptionResponse === "string"
          ? { statusCode: status, message: exceptionResponse }
          : exceptionResponse
      );
      return;
    }

    // Unexpected errors — return 500 to avoid leaking internals
    this.logger.error(
      `Unhandled exception: ${exception instanceof Error ? exception.message : exception}`,
      exception instanceof Error ? exception.stack : undefined
    );
    response.status(500).json({
      statusCode: 500,
      message: "Internal server error",
    });
  }
}
