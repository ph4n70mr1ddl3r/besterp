// Custom domain error classes for BestERP.
//
// These replace the fragile "CODE: message" string-parsing pattern.
// Each error class carries a structured code that the MCP error handler
// middleware can match on, plus optional metadata for rich AI responses.

/**
 * Base class for all BestERP domain errors.
 * Carries a machine-readable `code` and optional `suggestedTools`.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly suggestedTools: string[];
  readonly context: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options?: {
      suggestedTools?: string[];
      context?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.suggestedTools = options?.suggestedTools ?? [];
    this.context = options?.context ?? {};
  }
}

/** Thrown when required subtype data is missing (e.g., person details for PERSON party type). */
export class MissingSubtypeDataError extends DomainError {
  constructor(
    message: string,
    options?: { suggestedTools?: string[]; context?: Record<string, unknown> }
  ) {
    super("MISSING_SUBTYPE_DATA", message, options);
  }
}

/** Thrown when a type table value is invalid or not found. */
export class InvalidTypeValueError extends DomainError {
  constructor(
    message: string,
    options?: { suggestedTools?: string[]; context?: Record<string, unknown> }
  ) {
    super("INVALID_TYPE_VALUE", message, options);
  }
}

/** Thrown when a duplicate entity already exists. */
export class DuplicateEntityError extends DomainError {
  constructor(
    message: string,
    options?: { suggestedTools?: string[]; context?: Record<string, unknown> }
  ) {
    super("DUPLICATE_ENTITY", message, options);
  }
}

/** Thrown when a referenced entity is not found. */
export class EntityNotFoundError extends DomainError {
  constructor(
    message: string,
    options?: { suggestedTools?: string[]; context?: Record<string, unknown> }
  ) {
    super("ENTITY_NOT_FOUND", message, options);
  }
}

/**
 * Type guard — check if an error is a DomainError (or any subclass).
 */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}


