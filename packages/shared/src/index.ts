// @besterp/shared — Common utilities for BestERP packages

export { withTenant, validateTenantId } from "./tenant.js";

export {
  DomainError,
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyError,
  isDomainError,
  richError,
  type RichErrorContent,
} from "./errors.js";

export { hashInput } from "./crypto.js";
