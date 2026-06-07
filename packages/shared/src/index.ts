// @besterp/shared — Common utilities for BestERP packages

export { withTenant, validateTenantId } from "./tenant.js";

export {
  DomainError,
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  isDomainError,
  richError,
  type RichErrorContent,
} from "./errors.js";

export { hashInput } from "./crypto.js";

export { UUID_REGEX, EMAIL_REGEX, COUNTRY_CODE_REGEX } from "./validation.js";
