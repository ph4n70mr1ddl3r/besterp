// Party DTOs — Request validation classes for Party REST endpoints.
//
// These DTOs use class-validator decorators so that the global ValidationPipe
// can validate and transform incoming request bodies. Without these, the
// ValidationPipe had nothing to validate against — all fields passed through.
//
// Each DTO maps to a corresponding input type in party.types.ts but includes
// validation rules. The controller spreads these into the domain input types.
//
// VALIDATION STRATEGY (defense-in-depth across layers):
// - REST endpoints: class-validator DTOs in this file (ValidationPipe)
// - MCP tools: Zod schemas in party-tools.ts with superRefine for cross-field
// - Service layer: Explicit validation in party.service.ts
// - Database: Constraints (unique indexes, FK, CHECK) as final safety net

import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  ValidateNested,
  IsInt,
  Min,
  Max,
  MaxLength,
  MinLength,
  Matches,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
  ValidationArguments,
} from "class-validator";
import { Type, Transform, TransformFnParams } from "class-transformer";
import {
  stripHtmlTags,
  sanitizeForLogOutput,
  isValidISODate,
  EMAIL_REGEX,
  MAX_PARTY_NAME_LENGTH,
  MAX_PARTY_DESCRIPTION_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  MAX_MIDDLE_NAME_LENGTH,
  MAX_GENDER_LENGTH,
  MAX_LEGAL_NAME_LENGTH,
  MAX_TAX_ID_LENGTH,
  MAX_ROLE_TYPE_LENGTH,
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
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
  MAX_DATE_STRING_LENGTH,
  COUNTRY_CODE_REGEX,
} from "@besterp/shared";

function sanitizeTransform(): PropertyDecorator {
  return Transform(({ value }: TransformFnParams) => (typeof value === "string" ? stripHtmlTags(value.trim()) : value));
}

/**
 * Optional-string variant of sanitizeTransform: a value that sanitizes to
 * empty (whitespace-only or HTML-only like "<script>") is normalised to
 * undefined so @IsOptional() skips it — matching the MCP boundary's
 * optionalFilteredString ("   " → field not provided → stored as null).
 * Previously the empty string survived the DTO and hit the service layer,
 * so identical input got a 422 on REST but succeeded on MCP.
 * Do NOT use for search filters: those must stay defined so the service's
 * requireNonEmptyFilter can reject whitespace-only filters instead of
 * silently widening the query to "return all" (see SearchPartiesDto).
 */
function optionalSanitizeTransform(): PropertyDecorator {
  return Transform(({ value }: TransformFnParams) => {
    if (typeof value !== "string") return value;
    const sanitized = stripHtmlTags(value.trim());
    return sanitized.length === 0 ? undefined : sanitized;
  });
}

// ─── Date validator ─────────────────────────────────────────────

/**
 * Enforces the same strict ISO 8601 UTC (`...Z`) format the service layer
 * requires via `isValidISODate`. class-validator's built-in `@IsDateString`
 * accepts date-only strings like "2024-06-15", which would otherwise pass the
 * DTO layer and then fail later at the service layer with a confusing error —
 * so we validate the canonical format up front, matching the MCP Zod path.
 */
@ValidatorConstraint({ name: "isValidISODate", async: false })
class IsValidISODateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === "string" && isValidISODate(value);
  }

  defaultMessage(args: ValidationArguments): string {
    const rawValue = (args.object as Record<string, unknown>)[args.property];
    const sanitized = typeof rawValue === "string" ? sanitizeForLogOutput(rawValue) : String(rawValue ?? args.property);
    return `${sanitized} must be a valid ISO 8601 UTC date (e.g. 2024-06-15T00:00:00.000Z)`;
  }
}

function IsValidISODate(): PropertyDecorator {
  return Validate(IsValidISODateConstraint);
}

/**
 * Custom email validator using `EMAIL_REGEX` from shared — stricter than
 * class-validator's built-in `@IsEmail()` so DTO validation matches the
 * service-layer validation used by MCP tools.
 */
@ValidatorConstraint({ name: "isStrictEmail", async: false })
class IsStrictEmailConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== "string") return false;
    return EMAIL_REGEX.test(value);
  }

  defaultMessage(_args: ValidationArguments): string {
    return "Invalid email address format";
  }
}

function IsStrictEmail(): PropertyDecorator {
  return Validate(IsStrictEmailConstraint);
}

// ─── Cross-field validators ──────────────────────────────────────

/**
 * Validates that when partyType is PERSON, `person` is provided.
 * When partyType is ORGANIZATION, `organization` is provided.
 */
@ValidatorConstraint({ name: "partySubtypeMatch", async: false })
class PartySubtypeMatchConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as CreatePartyDto;
    // Guard against unknown partyType values that bypass @IsEnum (e.g. from
    // forged requests or future subtype additions not yet handled here).
    if (obj.partyType !== "PERSON" && obj.partyType !== "ORGANIZATION") return false;
    if (obj.partyType === "PERSON" && !obj.person) return false;
    if (obj.partyType === "ORGANIZATION" && !obj.organization) return false;
    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    const obj = args.object as CreatePartyDto;
    if (obj.partyType === "PERSON")
      return "'person' is required when partyType is PERSON";
    if (obj.partyType === "ORGANIZATION")
      return "'organization' is required when partyType is ORGANIZATION";
    return "Subtype data must match partyType";
  }
}

/**
 * Validates that only the matching subtype is provided (no extra data).
 */
@ValidatorConstraint({ name: "partySubtypeExclusive", async: false })
class PartySubtypeExclusiveConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as CreatePartyDto;
    // ORGANIZATION type should not include person data, and vice versa
    if (obj.partyType === "PERSON" && obj.organization) return false;
    if (obj.partyType === "ORGANIZATION" && obj.person) return false;
    return true;
  }

  defaultMessage(): string {
    return "Only the subtype matching partyType should be provided";
  }
}

// ─── Person Subtype ──────────────────────────────────────────────

export class CreatePersonDto {
  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PERSON_NAME_LENGTH)
  firstName!: string;

  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PERSON_NAME_LENGTH)
  lastName!: string;

  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_MIDDLE_NAME_LENGTH)
  middleName?: string;

  @IsOptional()
  @IsValidISODate()
  @MaxLength(MAX_DATE_STRING_LENGTH)
  birthDate?: string;

  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_GENDER_LENGTH)
  gender?: string;
}

// ─── Organization Subtype ────────────────────────────────────────

export class CreateOrganizationDto {
  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_LEGAL_NAME_LENGTH)
  legalName!: string;

  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_TAX_ID_LENGTH)
  taxId?: string;

  @IsOptional()
  @IsValidISODate()
  @MaxLength(MAX_DATE_STRING_LENGTH)
  registrationDate?: string;
}

// ─── Create Party ────────────────────────────────────────────────

export class CreatePartyDto {
  @IsEnum(["PERSON", "ORGANIZATION"])
  partyType!: "PERSON" | "ORGANIZATION";

  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PARTY_NAME_LENGTH)
  name!: string;

  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_PARTY_DESCRIPTION_LENGTH)
  description?: string;

  @ValidateNested()
  @IsOptional()
  @Type(() => CreatePersonDto)
  person?: CreatePersonDto;

  @ValidateNested()
  @IsOptional()
  @Type(() => CreateOrganizationDto)
  organization?: CreateOrganizationDto;

  // Cross-field validators run against the full DTO instance, not just this field.
  // _subtypeCheck is a phantom field (does not exist in the request body) — required
  // because class-validator executes decorators on the class, not on a specific value.
  @Validate(PartySubtypeMatchConstraint)
  @Validate(PartySubtypeExclusiveConstraint)
  _subtypeCheck?: unknown;
}

// ─── Search Parties ──────────────────────────────────────────────

export class SearchPartiesDto {
  @sanitizeTransform()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PARTY_NAME_LENGTH)
  name?: string;

  @IsOptional()
  @IsEnum(["PERSON", "ORGANIZATION"])
  partyType?: "PERSON" | "ORGANIZATION";

  @IsOptional()
  @sanitizeTransform()
  @IsString()
  @MaxLength(MAX_ROLE_TYPE_LENGTH)
  roleType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_SEARCH_LIMIT)
  @Max(MAX_SEARCH_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_SEARCH_OFFSET)
  @Max(MAX_SEARCH_OFFSET)
  offset?: number;
}

// ─── Add Party Role ──────────────────────────────────────────────

export class AddPartyRoleDto {
  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ROLE_TYPE_LENGTH)
  roleType!: string;

  @IsOptional()
  @IsValidISODate()
  @MaxLength(MAX_DATE_STRING_LENGTH)
  fromDate?: string;
}

// ─── Contact Mechanism Subtypes ──────────────────────────────────

export class PostalAddressDto {
  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ADDRESS_LINE_LENGTH)
  addressLine1!: string;

  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_ADDRESS_LINE_LENGTH)
  addressLine2?: string;

  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CITY_LENGTH)
  city!: string;

  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_STATE_PROVINCE_LENGTH)
  stateProvince?: string;

  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_POSTAL_CODE_LENGTH)
  postalCode?: string;

  @sanitizeTransform()
  @Transform(({ value }: TransformFnParams) =>
    typeof value === "string" ? stripHtmlTags(value.trim()).toUpperCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(MIN_COUNTRY_CODE_LENGTH)
  @MaxLength(MAX_COUNTRY_CODE_LENGTH)
  country!: string;
}

export class TelecomNumberDto {
  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_PHONE_COUNTRY_CODE_LENGTH)
  @Matches(COUNTRY_CODE_REGEX, { message: "countryCode must be an E.164 country code (e.g., '+1', '+44')" })
  countryCode?: string;

  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_AREA_CODE_LENGTH)
  areaCode!: string;

  @sanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_LINE_NUMBER_LENGTH)
  lineNumber!: string;

  @IsOptional()
  @optionalSanitizeTransform()
  @IsString()
  @MaxLength(MAX_EXTENSION_LENGTH)
  extension?: string;
}

export class EmailAddressDto {
  @Transform(({ value }: TransformFnParams) =>
    typeof value === "string" ? stripHtmlTags(value.trim().toLowerCase()) : value
  )
  @IsString()
  @IsStrictEmail()
  @IsNotEmpty()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;
}

// ─── Add Contact Mechanism ───────────────────────────────────────

/**
 * Validates that the correct contact subtype is provided for the contactMechanismType.
 */
@ValidatorConstraint({ name: "contactSubtypeMatch", async: false })
class ContactSubtypeMatchConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as AddContactMechanismDto;
    if (obj.contactMechanismType === "POSTAL_ADDRESS" && !obj.postalAddress) return false;
    if (obj.contactMechanismType === "TELECOM_NUMBER" && !obj.telecomNumber) return false;
    if (obj.contactMechanismType === "EMAIL_ADDRESS" && !obj.emailAddress) return false;
    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    const obj = args.object as AddContactMechanismDto;
    const map: Record<string, string> = {
      POSTAL_ADDRESS: "postalAddress",
      TELECOM_NUMBER: "telecomNumber",
      EMAIL_ADDRESS: "emailAddress",
    };
    const field = map[obj.contactMechanismType] || "subtype";
    return `'${field}' is required when contactMechanismType is ${obj.contactMechanismType}`;
  }
}

/**
 * Validates that only the matching subtype is provided (no extra data).
 */
@ValidatorConstraint({ name: "contactSubtypeExclusive", async: false })
class ContactSubtypeExclusiveConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as AddContactMechanismDto;
    if (obj.contactMechanismType === "POSTAL_ADDRESS" && (obj.telecomNumber || obj.emailAddress)) return false;
    if (obj.contactMechanismType === "TELECOM_NUMBER" && (obj.postalAddress || obj.emailAddress)) return false;
    if (obj.contactMechanismType === "EMAIL_ADDRESS" && (obj.postalAddress || obj.telecomNumber)) return false;
    return true;
  }

  defaultMessage(): string {
    return "Only the subtype matching contactMechanismType should be provided";
  }
}

export class AddContactMechanismDto {
  @IsEnum(["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"])
  contactMechanismType!: "POSTAL_ADDRESS" | "TELECOM_NUMBER" | "EMAIL_ADDRESS";

  @ValidateNested()
  @IsOptional()
  @Type(() => PostalAddressDto)
  postalAddress?: PostalAddressDto;

  @ValidateNested()
  @IsOptional()
  @Type(() => TelecomNumberDto)
  telecomNumber?: TelecomNumberDto;

  @ValidateNested()
  @IsOptional()
  @Type(() => EmailAddressDto)
  emailAddress?: EmailAddressDto;

  @Validate(ContactSubtypeMatchConstraint)
  @Validate(ContactSubtypeExclusiveConstraint)
  _subtypeCheck?: unknown;
}
