// @besterp/shared — Common utilities for BestERP packages

export { withTenant, validateTenantId } from "./tenant.js";

export {
  DomainError,
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyConflictError,
  isDomainError,
  getErrorCode,
} from "./errors.js";

export { hashInput } from "./crypto.js";

export { UUID_REGEX, EMAIL_REGEX, COUNTRY_CODE_REGEX } from "./validation.js";

export { stripHtmlTags } from "./sanitize.js";

export * from "./constants.js";
