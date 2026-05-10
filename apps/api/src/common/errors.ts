// Common error classes re-exported from @besterp/shared.
//
// Application-specific error classes can be added here for NestJS
// HTTP status mapping (e.g., NotFoundException → 404).
//
// The DomainExceptionFilter (domain-exception.filter.ts) handles
// DomainError → HTTP response mapping globally. The domainErrorToHttp()
// function is retained for explicit use in controllers if needed.

export {
  DomainError,
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyError,
  isDomainError,
} from "@besterp/shared";

import { DomainError } from "@besterp/shared";
import {
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * Map a DomainError to the appropriate NestJS HTTP exception.
 *
 * This is used by the global DomainExceptionFilter to determine status codes.
 * Can also be called explicitly in controllers for fine-grained error handling.
 */
export function domainErrorToHttp(error: DomainError) {
  switch (error.code) {
    case "ENTITY_NOT_FOUND":
      return new NotFoundException(error.message);
    case "DUPLICATE_ENTITY":
    case "DUPLICATE_ROLE":
      return new ConflictException(error.message);
    case "CONCURRENCY_CONFLICT":
      return new ConflictException(error.message);
    case "MISSING_SUBTYPE_DATA":
    case "INVALID_TYPE_VALUE":
      return new UnprocessableEntityException(error.message);
    default:
      return new UnprocessableEntityException(error.message);
  }
}
