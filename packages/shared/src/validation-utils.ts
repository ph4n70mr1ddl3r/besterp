// Validation utilities — Shared input validation helpers.
//
// Provides consistent validation logic across REST DTOs, MCP Zod schemas,
// and service-layer defense-in-depth checks. All functions throw
// InvalidTypeValueError with structured context for error handlers.

import {
  InvalidTypeValueError,
  UUID_REGEX,
  EMAIL_REGEX,
  COUNTRY_CODE_REGEX,
  isValidISODate,
} from "./index.js";

export interface ValidationOptions {
  /** Maximum allowed length */
  maxLength?: number;
  /** Minimum allowed length (after trimming) */
  minLength?: number;
  /** Regex pattern the value must match */
  pattern?: RegExp;
  /** Custom error message for pattern mismatch */
  patternMessage?: string;
  /** Field name for error context */
  field?: string;
  /** Suggested tools for MCP error responses */
  suggestedTools?: string[];
  /** Whether to allow empty strings after trimming */
  allowEmpty?: boolean;
  /** Whether to trim the value before validation */
  trim?: boolean;
  /** Whether to convert to lowercase after trimming */
  toLowerCase?: boolean;
  /** Whether to convert to uppercase after trimming */
  toUpperCase?: boolean;
}

/**
 * Validate a required string field.
 * Throws InvalidTypeValueError if validation fails.
 */
export function validateRequiredString(
  value: unknown,
  options: ValidationOptions = {},
): string {
  const {
    maxLength,
    minLength = 1,
    pattern,
    patternMessage,
    field = "field",
    suggestedTools = [],
    trim = true,
  } = options;

  if (typeof value !== "string") {
    throw new InvalidTypeValueError(
      `${field} is required and must be a string.`,
      { suggestedTools, context: { field, received: typeof value } },
    );
  }

  const processed = trim ? value.trim() : value;

  if (processed.length === 0) {
    throw new InvalidTypeValueError(
      `${field} is required and cannot be empty.`,
      { suggestedTools, context: { field, received: value } },
    );
  }

  if (processed.length < minLength) {
    throw new InvalidTypeValueError(
      `${field} is too short (${processed.length} chars, min ${minLength}).`,
      { suggestedTools, context: { field, length: processed.length, minLength } },
    );
  }

  if (maxLength !== undefined && processed.length > maxLength) {
    throw new InvalidTypeValueError(
      `${field} is too long (${processed.length} chars, max ${maxLength}).`,
      { suggestedTools, context: { field, length: processed.length, maxLength } },
    );
  }

  if (pattern && !pattern.test(processed)) {
    throw new InvalidTypeValueError(
      patternMessage ?? `${field} has an invalid format.`,
      { suggestedTools, context: { field, invalidValue: value } },
    );
  }

  return processed;
}

/**
 * Check string length constraints.
 */
function checkLengthConstraints(
  processed: string,
  options: { field: string; minLength: number; maxLength?: number; suggestedTools: string[] },
): void {
  if (processed.length < options.minLength) {
    throw new InvalidTypeValueError(
      `${options.field} is too short (${processed.length} chars, min ${options.minLength}).`,
      { suggestedTools: options.suggestedTools, context: { field: options.field, length: processed.length, minLength: options.minLength } },
    );
  }
  if (options.maxLength !== undefined && processed.length > options.maxLength) {
    throw new InvalidTypeValueError(
      `${options.field} is too long (${processed.length} chars, max ${options.maxLength}).`,
      { suggestedTools: options.suggestedTools, context: { field: options.field, length: processed.length, maxLength: options.maxLength } },
    );
  }
}

/**
 * Check pattern constraint.
 */
function checkPatternConstraint(
  processed: string,
  value: string,
  options: { field: string; pattern?: RegExp; patternMessage?: string; suggestedTools: string[] },
): void {
  if (options.pattern && !options.pattern.test(processed)) {
    throw new InvalidTypeValueError(
      options.patternMessage ?? `${options.field} has an invalid format.`,
      { suggestedTools: options.suggestedTools, context: { field: options.field, invalidValue: value } },
    );
  }
}

/**
 * Validate an optional string field.
 * Returns undefined if value is undefined/null/empty (after trim).
 * Throws InvalidTypeValueError if validation fails.
 */
// eslint-disable-next-line complexity
export function validateOptionalString(
  value: unknown,
  options: ValidationOptions = {},
): string | undefined {
  const {
    maxLength,
    minLength = 0,
    pattern,
    patternMessage,
    field = "field",
    suggestedTools = [],
    trim = true,
    allowEmpty = false,
    toLowerCase = false,
    toUpperCase = false,
  } = options;

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new InvalidTypeValueError(
      `${field} must be a string.`,
      { suggestedTools, context: { field, receivedType: typeof value } },
    );
  }

  let processed = trim ? value.trim() : value;

  if (!allowEmpty && processed.length === 0) {
    throw new InvalidTypeValueError(
      `${field} cannot be whitespace-only.`,
      { suggestedTools, context: { field } },
    );
  }

  if (processed.length === 0) {
    return undefined;
  }

  checkLengthConstraints(processed, { field, minLength, maxLength, suggestedTools });
  checkPatternConstraint(processed, value, { field, pattern, patternMessage, suggestedTools });

  if (toLowerCase) processed = processed.toLowerCase();
  if (toUpperCase) processed = processed.toUpperCase();

  return processed;
}

/**
 * Validate a UUID string.
 */
export function validateUuid(value: string, field = "id"): string {
  if (!UUID_REGEX.test(value)) {
    throw new InvalidTypeValueError(
      `Invalid '${field}': must be a valid UUID.`,
      { suggestedTools: [], context: { field, received: value } },
    );
  }
  return value;
}

/**
 * Validate an ISO 8601 date string.
 */
export function validateIsoDate(
  value: unknown,
  options: { field?: string; maxLength?: number; suggestedTools?: string[] } = {},
): string {
  const { field = "date", maxLength = 30, suggestedTools = [] } = options;

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidTypeValueError(
      `${field} must be a non-empty ISO 8601 date string.`,
      { suggestedTools, context: { field, received: String(value) } },
    );
  }

  if (value.length > maxLength) {
    throw new InvalidTypeValueError(
      `${field} is too long (${value.length} characters, max ${maxLength}).`,
      { suggestedTools, context: { field, length: value.length, maxLength } },
    );
  }

  const trimmed = value.trim();
  if (!isValidISODate(trimmed)) {
    throw new InvalidTypeValueError(
      `${field} is not a valid ISO 8601 date. Received: ${value}.`,
      { suggestedTools, context: { field, invalidValue: value } },
    );
  }

  return trimmed;
}

/**
 * Validate an email address.
 */
export function validateEmail(
  value: unknown,
  options: { field?: string; maxLength?: number; suggestedTools?: string[] } = {},
): string {
  const { field = "email", maxLength = 254, suggestedTools = [] } = options;

  if (typeof value !== "string") {
    throw new InvalidTypeValueError(
      `${field} must be a string.`,
      { suggestedTools, context: { field, receivedType: typeof value } },
    );
  }

  const processed = value.trim().toLowerCase();

  if (processed.length === 0) {
    throw new InvalidTypeValueError(
      `${field} is required and cannot be empty.`,
      { suggestedTools, context: { field } },
    );
  }

  if (processed.length > maxLength) {
    throw new InvalidTypeValueError(
      `${field} is too long (${processed.length} chars, max ${maxLength}).`,
      { suggestedTools, context: { field, length: processed.length, maxLength } },
    );
  }

  if (!EMAIL_REGEX.test(processed)) {
    throw new InvalidTypeValueError(
      `Invalid ${field} format.`,
      { suggestedTools, context: { field, invalidValue: processed } },
    );
  }

  return processed;
}

/**
 * Validate an E.164 country code (e.g., +1, +44, +81).
 */
export function validateCountryCode(
  value: unknown,
  options: { field?: string; maxLength?: number; suggestedTools?: string[] } = {},
): string {
  const { field = "countryCode", maxLength = 5, suggestedTools = [] } = options;

  if (typeof value !== "string") {
    throw new InvalidTypeValueError(
      `${field} must be a string.`,
      { suggestedTools, context: { field, receivedType: typeof value } },
    );
  }

  const processed = value.trim();

  if (processed.length === 0) {
    throw new InvalidTypeValueError(
      `${field} cannot be empty.`,
      { suggestedTools, context: { field } },
    );
  }

  if (processed.length > maxLength) {
    throw new InvalidTypeValueError(
      `${field} is too long (${processed.length} chars, max ${maxLength}).`,
      { suggestedTools, context: { field, length: processed.length, maxLength } },
    );
  }

  if (!COUNTRY_CODE_REGEX.test(processed)) {
    throw new InvalidTypeValueError(
      `${field} must be an E.164 country code (e.g., '+1', '+44').`,
      { suggestedTools, context: { field, invalidValue: processed } },
    );
  }

  return processed;
}