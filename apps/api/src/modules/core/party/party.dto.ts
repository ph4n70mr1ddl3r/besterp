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
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from "class-validator";
import { Type, Transform } from "class-transformer";

// ─── Cross-field validators ──────────────────────────────────────

/**
 * Validates that when partyType is PERSON, `person` is provided.
 * When partyType is ORGANIZATION, `organization` is provided.
 */
@ValidatorConstraint({ name: "partySubtypeMatch", async: false })
class PartySubtypeMatchConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: any): boolean {
    const obj = args.object as CreatePartyDto;
    if (obj.partyType === "PERSON" && !obj.person) return false;
    if (obj.partyType === "ORGANIZATION" && !obj.organization) return false;
    return true;
  }

  defaultMessage(args: any): string {
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
  validate(_value: unknown, args: any): boolean {
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
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  firstName!: string;

  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  lastName!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  middleName?: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(50)
  gender?: string;
}

// ─── Organization Subtype ────────────────────────────────────────

export class CreateOrganizationDto {
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  legalName!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(50)
  taxId?: string;

  @IsOptional()
  @IsDateString()
  registrationDate?: string;
}

// ─── Create Party ────────────────────────────────────────────────

export class CreatePartyDto {
  @IsEnum(["PERSON", "ORGANIZATION"])
  partyType!: "PERSON" | "ORGANIZATION";

  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  name!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
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
  _subtypeCheck?: unknown;
}

// ─── Search Parties ──────────────────────────────────────────────

export class SearchPartiesDto {
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  @IsOptional()
  @IsEnum(["PERSON", "ORGANIZATION"])
  partyType?: "PERSON" | "ORGANIZATION";

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  roleType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

// ─── Add Party Role ──────────────────────────────────────────────

export class AddPartyRoleDto {
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  roleType!: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;
}

// ─── Contact Mechanism Subtypes ──────────────────────────────────

export class PostalAddressDto {
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  addressLine1!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  stateProvince?: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim().toUpperCase() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(3)
  country!: string;
}

export class TelecomNumberDto {
  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(5)
  countryCode?: string;

  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  areaCode!: string;

  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  lineNumber!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(10)
  extension?: string;
}

export class EmailAddressDto {
  @Transform(({ value }: { value: string }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value
  )
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(254) // RFC 5321 limit
  email!: string;
}

// ─── Add Contact Mechanism ───────────────────────────────────────

/**
 * Validates that the correct contact subtype is provided for the contactMechanismType.
 */
@ValidatorConstraint({ name: "contactSubtypeMatch", async: false })
class ContactSubtypeMatchConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: any): boolean {
    const obj = args.object as AddContactMechanismDto;
    if (obj.contactMechanismType === "POSTAL_ADDRESS" && !obj.postalAddress) return false;
    if (obj.contactMechanismType === "TELECOM_NUMBER" && !obj.telecomNumber) return false;
    if (obj.contactMechanismType === "EMAIL_ADDRESS" && !obj.emailAddress) return false;
    return true;
  }

  defaultMessage(args: any): string {
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
  validate(_value: unknown, args: any): boolean {
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
