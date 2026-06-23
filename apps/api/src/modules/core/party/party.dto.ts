// Party DTOs — Request validation classes for Party REST endpoints.
//
// These DTOs use class-validator decorators so that the global ValidationPipe
// can validate and transform incoming request bodies. Without these, the
// ValidationPipe had nothing to validate against — all fields passed through.
//
// Each DTO maps to a corresponding input type in party.types.ts but includes
// validation rules. The controller spreads these into the domain input types.

import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsDateString,
  IsEmail,
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
  MAX_SEARCH_OFFSET,
  MAX_DATE_STRING_LENGTH,
  COUNTRY_CODE_REGEX,
} from "@besterp/shared";

function SanitizeTransform(): PropertyDecorator {
  return Transform(({ value }: TransformFnParams) => (typeof value === "string" ? stripHtmlTags(value.trim()) : value));
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
  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PERSON_NAME_LENGTH)
  firstName!: string;

  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PERSON_NAME_LENGTH)
  lastName!: string;

  @IsOptional()
  @SanitizeTransform()
  @IsString()
  @MaxLength(MAX_MIDDLE_NAME_LENGTH)
  middleName?: string;

  @IsOptional()
  @IsDateString()
  @MaxLength(MAX_DATE_STRING_LENGTH)
  birthDate?: string;

  @IsOptional()
  @SanitizeTransform()
  @IsString()
  @MaxLength(MAX_GENDER_LENGTH)
  gender?: string;
}

// ─── Organization Subtype ────────────────────────────────────────

export class CreateOrganizationDto {
  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_LEGAL_NAME_LENGTH)
  legalName!: string;

  @IsOptional()
  @SanitizeTransform()
  @IsString()
  @MaxLength(MAX_TAX_ID_LENGTH)
  taxId?: string;

  @IsOptional()
  @IsDateString()
  @MaxLength(MAX_DATE_STRING_LENGTH)
  registrationDate?: string;
}

// ─── Create Party ────────────────────────────────────────────────

export class CreatePartyDto {
  @IsEnum(["PERSON", "ORGANIZATION"])
  partyType!: "PERSON" | "ORGANIZATION";

  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PARTY_NAME_LENGTH)
  name!: string;

  @IsOptional()
  @SanitizeTransform()
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

  // Cross-field: correct subtype must be present for the chosen partyType
  @Validate(PartySubtypeMatchConstraint)
  // Cross-field: only the matching subtype should be provided
  @Validate(PartySubtypeExclusiveConstraint)
  // NOTE: _subtypeCheck is a phantom field — it does not exist in the request body.
  // class-validator runs all decorators on the DTO, so cross-field validators
  // placed here execute against the full DTO instance, not just this field.
  _subtypeCheck?: unknown;
}

// ─── Search Parties ──────────────────────────────────────────────

export class SearchPartiesDto {
  @SanitizeTransform()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PARTY_NAME_LENGTH)
  name?: string;

  @IsOptional()
  @IsEnum(["PERSON", "ORGANIZATION"])
  partyType?: "PERSON" | "ORGANIZATION";

  @IsOptional()
  @SanitizeTransform()
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
  @Min(0)
  @Max(MAX_SEARCH_OFFSET)
  offset?: number;
}

// ─── Add Party Role ──────────────────────────────────────────────

export class AddPartyRoleDto {
  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ROLE_TYPE_LENGTH)
  roleType!: string;

  @IsOptional()
  @IsDateString()
  @MaxLength(MAX_DATE_STRING_LENGTH)
  fromDate?: string;
}

// ─── Contact Mechanism Subtypes ──────────────────────────────────

export class PostalAddressDto {
  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ADDRESS_LINE_LENGTH)
  addressLine1!: string;

  @IsOptional()
  @SanitizeTransform()
  @IsString()
  @MaxLength(MAX_ADDRESS_LINE_LENGTH)
  addressLine2?: string;

  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CITY_LENGTH)
  city!: string;

  @IsOptional()
  @SanitizeTransform()
  @IsString()
  @MaxLength(MAX_STATE_PROVINCE_LENGTH)
  stateProvince?: string;

  @IsOptional()
  @SanitizeTransform()
  @IsString()
  @MaxLength(MAX_POSTAL_CODE_LENGTH)
  postalCode?: string;

  @Transform(({ value }: { value: string }) => (typeof value === "string" ? stripHtmlTags(value.trim().toUpperCase()) : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(MIN_COUNTRY_CODE_LENGTH)
  @MaxLength(MAX_COUNTRY_CODE_LENGTH)
  country!: string;
}

export class TelecomNumberDto {
  @IsOptional()
  @SanitizeTransform()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PHONE_COUNTRY_CODE_LENGTH)
  @Matches(COUNTRY_CODE_REGEX, { message: "countryCode must be an E.164 country code (e.g., '+1', '+44')" })
  countryCode?: string;

  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_AREA_CODE_LENGTH)
  areaCode!: string;

  @SanitizeTransform()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_LINE_NUMBER_LENGTH)
  lineNumber!: string;

  @IsOptional()
  @SanitizeTransform()
  @IsString()
  @MaxLength(MAX_EXTENSION_LENGTH)
  extension?: string;
}

export class EmailAddressDto {
  @Transform(({ value }: { value: string }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value
  )
  @IsEmail()
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
