// Common error classes re-exported from @besterp/shared.
//
// Application-specific error classes can be added here for NestJS
// HTTP status mapping (e.g., NotFoundException → 404).

export {
  DomainError,
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyError,
  isDomainError,
} from "@besterp/shared";

import { DomainError, InvalidTypeValueError } from "@besterp/shared";
import { NotFoundException, ConflictException } from "@nestjs/common";

/**
 * Map a DomainError to the appropriate NestJS HTTP exception.
 * Used by REST controllers to return correct status codes.
 */
export function domainErrorToHttp(error: DomainError) {
  switch (error.code) {
    case "ENTITY_NOT_FOUND":
      return new NotFoundException(error.message);
    case "DUPLICATE_ENTITY":
    case "DUPLICATE_ROLE":
      return new ConflictException(error.message);
    case "MISSING_SUBTYPE_DATA":
    case "INVALID_TYPE_VALUE":
    case "CONCURRENCY_CONFLICT":
      return new ConflictException(error.message);
    default:
      return new ConflictException(error.message);
  }
}
