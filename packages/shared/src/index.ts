// @besterp/shared — Common utilities for BestERP packages

export { withTenant, validateTenantId } from "./tenant.js";

export type { DomainErrorOptions } from "./errors.js";
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

export { UUID_REGEX, EMAIL_REGEX, COUNTRY_CODE_REGEX, ISO_DATE_REGEX, isValidISODate } from "./validation.js";

export { stripHtmlTags, safeFromCodePoint, sanitizeLogOutput } from "./sanitize.js";

export {
  MAX_PARTY_NAME_LENGTH,
  MAX_PARTY_DESCRIPTION_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  MAX_MIDDLE_NAME_LENGTH,
  MAX_LEGAL_NAME_LENGTH,
  MAX_TAX_ID_LENGTH,
  MAX_ROLE_TYPE_LENGTH,
  MAX_CONTACT_MECHANISM_TYPE_LENGTH,
  MAX_ADDRESS_LINE_LENGTH,
  MAX_CITY_LENGTH,
  MAX_STATE_PROVINCE_LENGTH,
  MAX_POSTAL_CODE_LENGTH,
  MAX_COUNTRY_CODE_LENGTH,
  MIN_COUNTRY_CODE_LENGTH,
  MAX_AREA_CODE_LENGTH,
  MAX_LINE_NUMBER_LENGTH,
  MAX_EXTENSION_LENGTH,
  MAX_PHONE_COUNTRY_CODE_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_GENDER_LENGTH,
  MAX_DATE_STRING_LENGTH,
  MAX_USER_ID_LENGTH,
  MAX_AGENT_ID_LENGTH,
  MAX_REASONING_LENGTH,
  MAX_CONVERSATION_ID_LENGTH,
  MAX_ROLE_LENGTH,
  MAX_TENANT_ID_LENGTH,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
  MAX_TENANT_CACHE_SIZE,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_MAX_RETRIES,
  IDEMPOTENCY_RETRY_BASE_DELAY_MS,
  MAX_STORED_PAYLOAD_SIZE,
  MAX_SOFT_FAILURE_MESSAGE_SIZE,
} from "./constants.js";
