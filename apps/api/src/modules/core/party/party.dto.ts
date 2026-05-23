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
} from "class-validator";
import { Type } from "class-transformer";

// ─── Person Subtype ──────────────────────────────────────────────

export class CreatePersonDto {
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @IsOptional()
  @IsString()
  middleName?: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @IsOptional()
  @IsString()
  gender?: string;
}

// ─── Organization Subtype ────────────────────────────────────────

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  legalName!: string;

  @IsOptional()
  @IsString()
  taxId?: string;

  @IsOptional()
  @IsDateString()
  registrationDate?: string;
}

// ─── Create Party ────────────────────────────────────────────────

export class CreatePartyDto {
  @IsEnum(["PERSON", "ORGANIZATION"])
  partyType!: "PERSON" | "ORGANIZATION";

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @ValidateNested()
  @IsOptional()
  @Type(() => CreatePersonDto)
  person?: CreatePersonDto;

  @ValidateNested()
  @IsOptional()
  @Type(() => CreateOrganizationDto)
  organization?: CreateOrganizationDto;
}

// ─── Search Parties ──────────────────────────────────────────────

export class SearchPartiesDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(["PERSON", "ORGANIZATION"])
  partyType?: "PERSON" | "ORGANIZATION";

  @IsOptional()
  @IsString()
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
  @IsString()
  @IsNotEmpty()
  roleType!: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;
}

// ─── Contact Mechanism Subtypes ──────────────────────────────────

export class PostalAddressDto {
  @IsString()
  @IsNotEmpty()
  addressLine1!: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsString()
  @IsNotEmpty()
  city!: string;

  @IsOptional()
  @IsString()
  stateProvince?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsString()
  @IsNotEmpty()
  country!: string;
}

export class TelecomNumberDto {
  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsString()
  @IsNotEmpty()
  areaCode!: string;

  @IsString()
  @IsNotEmpty()
  lineNumber!: string;

  @IsOptional()
  @IsString()
  extension?: string;
}

export class EmailAddressDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}

// ─── Add Contact Mechanism ───────────────────────────────────────

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
}
