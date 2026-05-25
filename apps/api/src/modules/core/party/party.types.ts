// Party Types — Input/Output interfaces for the Party domain.
//
// These DTOs define the contract between MCP tools / REST endpoints
// and the Party domain service. They are the canonical shape of data
// flowing in and out of party operations.

// ─── Create Party ─────────────────────────────────────────────────

export interface PersonInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  birthDate?: string;   // ISO 8601
  gender?: string;
}

export interface OrganizationInput {
  legalName: string;
  taxId?: string;
  registrationDate?: string; // ISO 8601
}

export interface CreatePartyInput {
  tenantId: string;
  partyType: "PERSON" | "ORGANIZATION";
  name: string;
  description?: string;
  person?: PersonInput;
  organization?: OrganizationInput;
}

// ─── Create Party Result ──────────────────────────────────────────

export interface PartyResult {
  partyId: string;
  name: string;
  partyType: string;
  tenantId: string;
  description?: string | null;
  person: {
    firstName: string;
    lastName: string;
    middleName?: string | null;
    birthDate?: string | null;
    gender?: string | null;
  } | null;
  organization: {
    legalName: string;
    taxId?: string | null;
    registrationDate?: string | null;
  } | null;
  roles: Array<{
    partyRoleId: string;
    roleTypeName: string;
    fromDate: string;
    thruDate?: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

// ─── Search Parties ───────────────────────────────────────────────

export interface SearchPartiesInput {
  tenantId: string;
  name?: string;
  partyType?: string;
  roleType?: string;
  limit?: number;
  offset?: number;
}

export interface SearchPartiesResult {
  items: PartyResult[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ─── Add Party Role ───────────────────────────────────────────────

export interface AddPartyRoleInput {
  tenantId: string;
  partyId: string;
  roleType: string;  // e.g., "Customer", "Supplier"
  fromDate?: string;
}

export interface PartyRoleResult {
  partyRoleId: string;
  partyId: string;
  roleTypeName: string;
  fromDate: string;
  thruDate?: string | null;
}

// ─── Add Contact Mechanism ────────────────────────────────────────

export interface PostalAddressInput {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateProvince?: string;
  postalCode?: string;
  country: string;
}

export interface TelecomNumberInput {
  countryCode?: string;
  areaCode: string;
  lineNumber: string;
  extension?: string;
}

export interface EmailAddressInput {
  email: string;
}

export interface AddContactMechanismInput {
  tenantId: string;
  partyId: string;
  contactMechanismType: "POSTAL_ADDRESS" | "TELECOM_NUMBER" | "EMAIL_ADDRESS";
  postalAddress?: PostalAddressInput;
  telecomNumber?: TelecomNumberInput;
  emailAddress?: EmailAddressInput;
}

export interface ContactMechanismResult {
  contactMechanismId: string;
  contactMechanismType: string;
  partyId: string;
  postalAddress: PostalAddressInput | null;
  telecomNumber: TelecomNumberInput | null;
  emailAddress: EmailAddressInput | null;
}
