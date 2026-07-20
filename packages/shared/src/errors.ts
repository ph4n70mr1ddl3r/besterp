import { redactSensitiveFieldValues, sanitizeForLogOutput } from "./sanitize.js";

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
  readonly context: Record<string, ContextValue>;

  constructor(
    code: string,
    message: string,
    options?: DomainErrorOptions
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
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
      // `message` routinely echoes user-supplied input (connection strings,
      // `?api_key=…`). Sanitize it here for defense-in-depth so any caller that
      // serializes a DomainError via `JSON.stringify(error)` (the canonical
      // structured serializer for audit logs / idempotency records) cannot leak
      // a secret verbatim — matching what the REST `DomainExceptionFilter` and
      // the MCP `error-handler` already apply to `error.message` before
      // reflecting/persisting it. `code` is a short allowlisted constant, safe.
      message: sanitizeForLogOutput(this.message),
      suggestedTools: this.suggestedTools,
      // Redact values stored under sensitive-named keys (password, apiKey, …)
      // and sanitize every string leaf before serialization. toJSON is the
      // canonical structured serializer used for audit logs, idempotency
      // records, and any other context where errors are serialized — so a secret
      // attached under a sensitive-named context key must not reach those
      // durable sinks verbatim. This keeps toJSON consistent with the REST
      // DomainExceptionFilter.sanitizeContext path and the MCP
      // redactSensitiveFields surface.
      context: redactSensitiveFieldValues(this.context) as Record<string, ContextValue>,
      cause: serializeCause(this.cause),
    };
  }
}

/**
 * Serialize a DomainError's cause for JSON output. Extracted from
 * DomainError.toJSON to avoid allocating an IIFE on every call.
 *
 * Only serializes the immediate cause's message — not its own cause chain —
 * to prevent leaking internal error chains (e.g., Prisma errors with
 * SQL/connection details) into audit logs or idempotency records.
 * `stack` is deliberately omitted to prevent leaking internal stack frames.
 *
 * A non-Error cause (e.g. an attached object) is NOT stringified via
 * `String(cause)` because a custom class's `toString()` can embed sensitive
 * field data into durable sinks (audit logs, idempotency records). We return
 * a safe placeholder instead, consistent with the redaction applied to
 * `context` values — callers must never attach secrets as `cause`.
 */
function serializeCause(cause: unknown): unknown {
  if (cause === undefined || cause === null) return cause;
  if (cause instanceof Error) return cause.message;
  return "[Non-error cause]";
}

// NOTE: not named ErrorOptions to avoid shadowing the global ErrorOptions
// interface from lib.es2022.error.d.ts (which has { cause?: unknown }).
/**
 * Safe context values — only primitives and simple arrays to prevent accidental
 * sensitive data exposure. Values must not contain circular references — the
 * sanitizer will catch them but will return `[Circular]` instead of the value.
 */
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

/** Thrown when a tenant ID fails format validation (empty, too long, or contains invalid characters). */
export class InvalidTenantIdError extends DomainError {
  static readonly CODE = "INVALID_TENANT_ID";
  constructor(
    message: string,
    options?: DomainErrorOptions
  ) {
    super(InvalidTenantIdError.CODE, message, options);
    this.name = "InvalidTenantIdError";
  }
}

/**
 * Thrown when the set_tenant_context() PostgreSQL function fails, typically
 * because the function does not exist or the database role lacks permissions.
 * Used by withTenant() in @besterp/shared/tenant.ts and by createTenantClient()
 * in @besterp/database/rls-extension.ts.
 */
export class TenantContextFailedError extends DomainError {
  static readonly CODE = "TENANT_CONTEXT_FAILED";
  constructor(
    message: string,
    options?: DomainErrorOptions
  ) {
    super(TenantContextFailedError.CODE, message, options);
    this.name = "TenantContextFailedError";
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

