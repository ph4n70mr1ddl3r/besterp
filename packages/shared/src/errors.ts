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
    options?: DomainErrorOptions
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    // Hardcode name to survive minification (terser/mangle renames classes).
    // Subclasses must override this.name with their own class name.
    this.name = "DomainError";
    this.code = code;
    this.suggestedTools = options?.suggestedTools ?? [];
    this.context = options?.context ?? {};
    // Fix instanceof checks for custom Error subclasses in environments
    // that don't properly support class extension of built-ins.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Override toJSON to ensure DomainError properties survive JSON serialization.
   * Error properties are non-enumerable by default, so JSON.stringify produces {}.
   * This method explicitly exposes the structured fields for audit logs, idempotency
   * records, and any other context where errors are serialized.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      suggestedTools: this.suggestedTools,
      context: this.context,
      cause: (() => {
        try {
          if (this.cause === undefined || this.cause === null) return this.cause;
          if (!(this.cause instanceof Error)) return String(this.cause);
          // Only serialize the immediate cause's message, not its own cause chain,
          // to prevent leaking internal error chains (e.g., Prisma errors with
          // SQL/connection details) into audit logs or idempotency records.
          // NOTE: `stack` is deliberately omitted from the top-level serialization
          // to prevent leaking internal stack frames (Prisma, database drivers,
          // Node internals) into audit logs and error responses.
          return this.cause.message;
        } catch {
          return "[Error serializing cause]";
        }
      })(),
    };
  }
}

// NOTE: not named ErrorOptions to avoid shadowing the global ErrorOptions
// interface from lib.es2022.error.d.ts (which has { cause?: unknown }).
/** Safe context values — only primitives and simple arrays to prevent accidental sensitive data exposure. */
export type ContextValue = string | number | boolean | null | ContextValue[] | { [key: string]: ContextValue };

export interface DomainErrorOptions {
  suggestedTools?: string[];
  context?: Record<string, ContextValue>;
  cause?: unknown;
}

/** Thrown when required subtype data is missing (e.g., person details for PERSON party type). */
export class MissingSubtypeDataError extends DomainError {
  static readonly CODE = "MISSING_SUBTYPE_DATA";
  constructor(
    message: string,
    options?: DomainErrorOptions
  ) {
    super(MissingSubtypeDataError.CODE, message, options);
    this.name = "MissingSubtypeDataError";
  }
}

/** Thrown when a type table value is invalid or not found. */
export class InvalidTypeValueError extends DomainError {
  static readonly CODE = "INVALID_TYPE_VALUE";
  constructor(
    message: string,
    options?: DomainErrorOptions
  ) {
    super(InvalidTypeValueError.CODE, message, options);
    this.name = "InvalidTypeValueError";
  }
}

/** Thrown when a duplicate entity already exists. */
export class DuplicateEntityError extends DomainError {
  static readonly CODE = "DUPLICATE_ENTITY";
  constructor(
    message: string,
    options?: DomainErrorOptions
  ) {
    super(DuplicateEntityError.CODE, message, options);
    this.name = "DuplicateEntityError";
  }
}

/** Thrown when a referenced entity is not found. */
export class EntityNotFoundError extends DomainError {
  static readonly CODE = "ENTITY_NOT_FOUND";
  constructor(
    message: string,
    options?: DomainErrorOptions
  ) {
    super(EntityNotFoundError.CODE, message, options);
    this.name = "EntityNotFoundError";
  }
}

/** Thrown when a concurrency conflict is detected (e.g., stale version, serialization failure). */
export class ConcurrencyConflictError extends DomainError {
  static readonly CODE = "CONCURRENCY_CONFLICT";
  constructor(
    message: string,
    options?: DomainErrorOptions
  ) {
    super(ConcurrencyConflictError.CODE, message, options);
    this.name = "ConcurrencyConflictError";
  }
}

/**
 * Type guard — check if an error is a DomainError (or any subclass).
 */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * Safely extract an error code (e.g., Prisma P2002, P2034) from a caught error,
 * returning undefined if the error or its code property is absent.
 *
 * This avoids repetitive `(e != null && typeof e === "object") ...` boilerplate
 * in catch blocks throughout the codebase.
 */
export function getErrorCode(error: unknown): string | undefined {
  if (error != null && typeof error === "object") {
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

