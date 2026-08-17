import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { AddContactMechanismDto, CreatePartyDto, PostalAddressDto, SearchPartiesDto, TelecomNumberDto, CreatePersonDto, CreateOrganizationDto, AddPartyRoleDto } from "./party.dto.js";

/**
 * Regression tests (round 150) for the optional-string normalisation split:
 * optional VALUE fields that sanitise to empty become undefined (matching
 * the MCP boundary's optionalFilteredString), while SEARCH filters stay
 * defined so the service's requireNonEmptyFilter can reject whitespace-only
 * filters instead of silently widening the query to "return all".
 */

async function errors(instance: object): Promise<string[]> {
  const errs = await validate(instance, { whitelist: true });
  return errs.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe("CreatePartyDto optionalSanitizeTransform", () => {
  it("normalizes whitespace-only description to undefined (matches MCP boundary)", async () => {
    const dto = plainToInstance(CreatePartyDto, {
      partyType: "PERSON",
      name: "Jane Doe",
      description: "   ",
      person: { firstName: "Jane", lastName: "Doe" },
    });
    const errs = await errors(dto);
    expect(errs).toHaveLength(0);
    expect(dto.description).toBeUndefined();
  });

  it("normalizes HTML-only description to undefined", async () => {
    const dto = plainToInstance(CreatePartyDto, {
      partyType: "PERSON",
      name: "Jane Doe",
      description: "<script>",
      person: { firstName: "Jane", lastName: "Doe" },
    });
    const errs = await errors(dto);
    expect(errs).toHaveLength(0);
    expect(dto.description).toBeUndefined();
  });

  it("keeps a sanitized non-empty description", async () => {
    const dto = plainToInstance(CreatePartyDto, {
      partyType: "PERSON",
      name: "Jane Doe",
      description: "  <b>Founder</b>  ",
      person: { firstName: "Jane", lastName: "Doe" },
    });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.description).toBe("Founder");
  });
});

describe("SearchPartiesDto whitespace-only filters", () => {
  it("keeps a whitespace-only name filter defined so the service can reject it", async () => {
    const dto = plainToInstance(SearchPartiesDto, { name: "   " });
    // The DTO itself must pass — rejection is the service layer's contract
    // (requireNonEmptyFilter), so the value has to survive as "".
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.name).toBe("");
  });

  it("trims a real name filter", async () => {
    const dto = plainToInstance(SearchPartiesDto, { name: "  Acme  " });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.name).toBe("Acme");
  });
});

describe("contact subtype optional fields", () => {
  it("normalizes whitespace-only countryCode to undefined (service defaults to +1)", async () => {
    const dto = plainToInstance(TelecomNumberDto, { areaCode: "555", lineNumber: "1234567", countryCode: "   " });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.countryCode).toBeUndefined();
  });

  it("normalizes whitespace-only addressLine2 / stateProvince / postalCode to undefined", async () => {
    const dto = plainToInstance(PostalAddressDto, {
      addressLine1: "123 Main St",
      city: "Anytown",
      country: "US",
      addressLine2: " ",
      stateProvince: " ",
      postalCode: " ",
    });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.addressLine2).toBeUndefined();
    expect(dto.stateProvince).toBeUndefined();
    expect(dto.postalCode).toBeUndefined();
  });

  it("still rejects a countryCode that sanitizes to a non-matching value", async () => {
    const dto = plainToInstance(TelecomNumberDto, { areaCode: "555", lineNumber: "1234567", countryCode: "1" });
    expect(await errors(dto)).not.toHaveLength(0);
  });

  it("still enforces exclusivity across contact subtypes", async () => {
    const dto = plainToInstance(AddContactMechanismDto, {
      contactMechanismType: "EMAIL_ADDRESS",
      emailAddress: { email: "a@b.com" },
      telecomNumber: { areaCode: "555", lineNumber: "1234567" },
    });
    expect(await errors(dto)).not.toHaveLength(0);
  });
});

describe("optional date fields trim whitespace (round 166)", () => {
  it("normalizes whitespace-padded birthDate to a clean value", async () => {
    const dto = plainToInstance(CreatePersonDto, {
      firstName: "Jane",
      lastName: "Doe",
      birthDate: "  2024-01-15T00:00:00.000Z  ",
    });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.birthDate).toBe("2024-01-15T00:00:00.000Z");
  });

  it("normalizes whitespace-padded registrationDate to a clean value", async () => {
    const dto = plainToInstance(CreateOrganizationDto, {
      legalName: "Acme Corp",
      registrationDate: "  2024-06-01T00:00:00.000Z  ",
    });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.registrationDate).toBe("2024-06-01T00:00:00.000Z");
  });

  it("normalizes whitespace-only date to undefined (matches MCP boundary)", async () => {
    const dto = plainToInstance(CreatePersonDto, {
      firstName: "Jane",
      lastName: "Doe",
      birthDate: "   ",
    });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.birthDate).toBeUndefined();
  });

  it("rejects a non-ISO date after trimming", async () => {
    const dto = plainToInstance(CreatePersonDto, {
      firstName: "Jane",
      lastName: "Doe",
      birthDate: " not-a-date ",
    });
    expect(await errors(dto)).not.toHaveLength(0);
  });

  it("normalizes whitespace-padded fromDate to a clean value (round 169)", async () => {
    const dto = plainToInstance(AddPartyRoleDto, {
      roleType: "Customer",
      fromDate: "  2024-01-15T00:00:00.000Z  ",
    });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.fromDate).toBe("2024-01-15T00:00:00.000Z");
  });

  it("normalizes whitespace-only fromDate to undefined (matches MCP boundary, round 169)", async () => {
    const dto = plainToInstance(AddPartyRoleDto, {
      roleType: "Customer",
      fromDate: "   ",
    });
    expect(await errors(dto)).toHaveLength(0);
    expect(dto.fromDate).toBeUndefined();
  });
});
