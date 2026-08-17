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
  TenantContextFailedError, isDev,
} from "@besterp/shared";

/**
 * Leading-prefix patterns that class-validator prepends to constraint error
 * messages (e.g. "isString() value must be a string", "minLength() must be longer
 * than or equal to 1 character"). Stripping only the prefix keeps the actionable
 * remainder ("value must be a string", "must be longer than or equal to 1
 * character") while discarding the mechanically-generated decorator name.
 *
 * The exhaustive enum-style list is intentionally conservative: adding a new
 * prefix without updating this list would let raw class-validator internals
 * leak into client-facing responses. When class-validator adds a new prefix,
 * add it here and run the regression tests to confirm the new shape is handled.
 */
const CLASS_VALIDATOR_PREFIX_REGEX = /^(is\w+|mustBe\w+|must be [a-z ]+|should be [a-z ]+|should not be [a-z ]+|is not [a-z ]+|must contain|must not contain|should contain|should not contain|is optional|must be optional|is required|must be required|minAllowed|maxAllowed|notIn|min|max|length|equals|matches|isArray|minDecimalValue|isNotEmpty|isEmpty|isBoolean|isDate|isNumber|isString|isEnum|isInstanceOf|arrayMinSize|arrayMaxSize|isTrue|isFalse|isNull|isNotNull)[^a-zA-Z]*/i;

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
    case TenantContextFailedError.CODE:
      return 503;
    default:
      return 500;
  }
}

/**
 * Serialize a non-Error exception to a human-readable string for logging.
 * Attempts JSON.stringify for structured objects; falls back to String()
 * when serialization throws (e.g. circular references, Symbols, Functions).
 */
function serializeExceptionDescription(exception: unknown): string {
  if (exception instanceof Error) return exception.message;
  try {
    return JSON.stringify(exception);
  } catch {
    return String(exception);
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
        `Headers already sent — cannot write error response. Exception: ${sanitizeForLogOutput(serializeExceptionDescription(exception))}`
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
        `Unknown DomainError code '${sanitizeForLogOutput(exception.code)}' — add a mapping in domainErrorToStatus(). Context: ${JSON.stringify(redactSensitiveFieldValues(exception.context))}. Suggested tools: ${JSON.stringify(exception.suggestedTools.map((t) => sanitizeForLogOutput(t)))}.`
      );
    } else {
      this.logger.debug(
        `DomainError [${exception.code}]: ${sanitizeForLogOutput(exception.message)}`
      );
    }

    const dev = isDev();
    const body: Record<string, unknown> = {
      statusCode: status,
      // Sanitize the error code to strip any control characters or ANSI
      // sequences that a custom DomainError subclass might embed. While
      // built-in codes are constants, the code field is user-controllable
      // via the DomainError constructor, and must not reach the client
      // verbatim any more than the message field does.
      error: status === 500 && !dev
        ? "INTERNAL_ERROR"
        : stripHtmlTags(sanitizeForLogOutput(exception.code)),
      // DomainError messages embed user-supplied input (invalid values, received
      // fields, malformed dates). These values survive upstream .trim() and may
      // contain control chars, HTML, or secrets (connection strings, tokens).
      // sanitizeForLogOutput strips control chars/ANSI and redacts URLs/secrets;
      // stripHtmlTags runs last for stored-XSS defense.
      message: status === 500 && !dev
        ? "An unexpected error occurred"
        : stripHtmlTags(sanitizeForLogOutput(exception.message)),
    };
    if (dev && exception.suggestedTools.length > 0) {
      body.suggestedTools = exception.suggestedTools;
    }
    if (dev && Object.keys(exception.context).length > 0) {
      body.context = redactSensitiveFieldValues(exception.context);
    }
    response.status(status).json(body);
  }

  private handleHttpException(exception: HttpException, response: Response): void {
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    // Only the explicit development environment is permissive; staging/preview/
    // uat deployments must NOT return raw error bodies.
    const dev = isDev();
    if (typeof exceptionResponse === "string") {
      response.status(status).json({ statusCode: status, message: stripHtmlTags(sanitizeForLogOutput(exceptionResponse)) });
      return;
    }
    if (!dev && typeof exceptionResponse === "object" && exceptionResponse !== null) {
      const res = exceptionResponse as Record<string, unknown>;
      const safeBody: Record<string, unknown> = { statusCode: status };
      if (typeof res.message === "string") {
        // Scrub secret-shaped values (connection strings, Bearer tokens) the
        // same way the array-validation and DomainError paths do.
        safeBody.message = stripHtmlTags(sanitizeForLogOutput(res.message));
      } else if (Array.isArray(res.message)) {
        // Strip user-supplied values from per-field detail strings while
        // preserving the field name and constraint description.
        // Use a conservative whitelist approach: known class-validator
        // constraint prefixes are stripped, then any trailing quoted
        // literal is removed. This is more robust than trying to match
        // the full message format with a single regex — class-validator
        // message shapes vary across constraints and versions, so a
        // whitelist of prefixes is less fragile than a blanket regex.
        // Remove leading class-validator constraint prefixes (see
        // CLASS_VALIDATOR_PREFIX_REGEX). A trailing quoted literal (the
        // received value) is then removed by the next step.
        const cleaned: string[] = res.message
          .map((m) => {
            if (typeof m !== "string") return "Validation error";
            let stripped = m;
            const prefixMatch = stripped.match(CLASS_VALIDATOR_PREFIX_REGEX);
            if (prefixMatch) {
              stripped = stripped.slice(prefixMatch[0].length).trim();
            }
            // Strip any trailing quoted literal or `received: "…"` suffix.
            stripped = stripped
              .replace(/\s*received\s*:\s*"[^"]*"\s*$/i, "")
              .replace(/\s*received\s*:\s*'[^']*'\s*$/i, "")
              .replace(/\s*"[^"]*"\s*$/, "")
              .replace(/\s*'[^']*'\s*$/, "")
              .replace(/[.,;:]\s*$/, "")
              .trim();
            return stripped || m.split(" ")[0] || "Validation error";
          })
          .filter(Boolean);
        safeBody.message = cleaned.length > 0
          ? cleaned.map((c) => sanitizeForLogOutput(c))
          : (status === 400 ? "Validation failed" : "Request error");
      } else {
        safeBody.message = status === 400 ? "Validation failed" : "Request error";
      }
      if (typeof res.error === "string") safeBody.error = stripHtmlTags(sanitizeForLogOutput(res.error));
      response.status(status).json(safeBody);
      return;
    }

    // In dev, reflect exceptionResponse for debugging; in production use a
    // safe generic body so internal fields cannot leak.
    if (!dev) {
      response.status(status).json({ statusCode: status });
      return;
    }
    response.status(status).json(exceptionResponse ?? { statusCode: status });
  }

  private handleUnexpectedError(exception: unknown, response: Response): void {
    const errorCode = getErrorCode(exception);
    const description = serializeExceptionDescription(exception);
    this.logger.error(
      `Unhandled exception${errorCode ? ` [${errorCode}]` : ""}: ${sanitizeForLogOutput(description)}`,
      exception instanceof Error && exception.stack ? sanitizeForLogOutput(exception.stack) : undefined
    );
    const dev = isDev();
    const responseMessage = dev && exception instanceof Error
      ? stripHtmlTags(sanitizeForLogOutput(exception.message))
          // Collapse absolute file paths that could leak implementation details
          // (e.g. /opt/app/node_modules/…) to [PATH]. Require a leading / or
          // Windows drive letter so bare filenames in prose are not affected.
          .replace(/(^|\s)(?:\/(?:[^\s'":/]+\/)+[^\s'":/]+\.(?:js|ts|json|env|yaml|yml|sql|pem|key|cert|config|conf|toml)|[A-Za-z]:\\[^\s'":]+\.(?:js|ts|json|env|yaml|yml|sql|pem|key|cert|config|conf|toml))/g, "$1[PATH]")
      : "Internal server error";
    response.status(500).json({
      statusCode: 500,
      error: "INTERNAL_ERROR",
      message: responseMessage,
    });
  }
}
