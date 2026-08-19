// Unit tests for Party MCP Tools — Zod schema validation, handler delegation, response formatting
// Tests the tool definitions in party-tools.ts: schema parsing, service access, error handling

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry, type ToolContext } from "@besterp/mcp-tools";
import { registerPartyTools } from "./party-tools.js";

// ─── Mock PartyService ─────────────────────────────────────────

function createMockPartyService() {
  return {
    createParty: vi.fn().mockResolvedValue({
      partyId: "new-party-id",
      partyType: "PERSON",
      name: "Test Party",
      tenantId: "tenant-1",
    }),
    getParty: vi.fn().mockResolvedValue({
      partyId: "existing-party",
      partyType: "ORGANIZATION",
      name: "Existing Org",
      tenantId: "tenant-1",
    }),
    searchParties: vi.fn().mockResolvedValue({
      parties: [],
      total: 0,
      hasMore: false,
      limit: 50,
      offset: 0,
    }),
    addPartyRole: vi.fn().mockResolvedValue({
      partyId: "existing-party",
      roleType: "Customer",
      fromDate: "2024-01-01",
    }),
    addContactMechanism: vi.fn().mockResolvedValue({
      partyId: "existing-party",
      contactMechanismType: "EMAIL_ADDRESS",
      emailAddress: { email: "test@example.com" },
    }),
  };
}

function createContext(services: Record<string, unknown> = {}): ToolContext {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    services,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Party MCP Tools", () => {
  let registry: ToolRegistry;
  let mockPartyService: ReturnType<typeof createMockPartyService>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
    mockPartyService = createMockPartyService();
    registerPartyTools(registry);
  });

  describe("getPartyService (internal guard)", () => {
    it("should throw InvalidTypeValueError when partyService is missing", async () => {
      await expect(
        registry.execute("get_party", { partyId: "550e8400-e29b-41d4-a716-446655440000" }, createContext())
      ).rejects.toThrow("PartyService not available");
    });

    it("should throw InvalidTypeValueError when partyService is not an object", async () => {
      await expect(
        registry.execute("get_party", { partyId: "550e8400-e29b-41d4-a716-446655440000" }, createContext({ partyService: "not-an-object" }))
      ).rejects.toThrow("PartyService not available");
    });
  });

  describe("create_party", () => {
    it("should create a person with valid input", async () => {
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "Jane Doe",
        person: { firstName: "Jane", lastName: "Doe" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.nextActions).toBeDefined();
      expect(result.nextActions!.length).toBeGreaterThan(0);
      expect(mockPartyService.createParty).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          partyType: "PERSON",
          name: "Jane Doe",
        })
      );
    });

    it("should create an organization with valid input", async () => {
      const result = await registry.execute("create_party", {
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        organization: { legalName: "Acme Corp Ltd." },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(mockPartyService.createParty).toHaveBeenCalledWith(
        expect.objectContaining({
          partyType: "ORGANIZATION",
          organization: { legalName: "Acme Corp Ltd." },
        })
      );
    });

    it("should reject PERSON without person field", async () => {
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "Jane",
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(result.error?.message).toContain("person");
    });

    it("should reject ORGANIZATION without organization field", async () => {
      const result = await registry.execute("create_party", {
        partyType: "ORGANIZATION",
        name: "Acme",
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(result.error?.message).toContain("organization");
    });

    it("should reject PERSON with organization field", async () => {
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "Jane",
        person: { firstName: "Jane", lastName: "Doe" },
        organization: { legalName: "Should not be here" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(result.error?.message).toContain("organization");
    });

    it("should reject missing name", async () => {
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        person: { firstName: "Jane", lastName: "Doe" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should reject empty name", async () => {
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "",
        person: { firstName: "Jane", lastName: "Doe" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should strip HTML from name", async () => {
      await registry.execute("create_party", {
        partyType: "PERSON",
        name: "<script>alert('xss')</script>Jane",
        person: { firstName: "Jane", lastName: "Doe" },
      }, createContext({ partyService: mockPartyService }));

      expect(mockPartyService.createParty).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Jane" })
      );
    });

    it("should trim whitespace from name", async () => {
      await registry.execute("create_party", {
        partyType: "PERSON",
        name: "  Jane Doe  ",
        person: { firstName: "Jane", lastName: "Doe" },
      }, createContext({ partyService: mockPartyService }));

      expect(mockPartyService.createParty).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Jane Doe" })
      );
    });

    it("should accept an optional field padded to just over the max length (length is checked after trim)", async () => {
      // Regression guard (round 107): optionalFilteredString previously
      // length-checked the RAW untrimmed string, so `description` of exactly
      // MAX_PARTY_DESCRIPTION_LENGTH chars + trailing whitespace was rejected —
      // while the required-field schema (sanitizedString) and the service layer
      // (which trims before length-checking) both accept it.
      const description = `${"x".repeat(1000)} `;
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "Jane Doe",
        description,
        person: { firstName: "Jane", lastName: "Doe" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(mockPartyService.createParty).toHaveBeenCalledWith(
        expect.objectContaining({ description: "x".repeat(1000) })
      );
    });

    it("should still reject an optional field whose trimmed value exceeds the max length", async () => {
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "Jane Doe",
        description: "x".repeat(1001),
        person: { firstName: "Jane", lastName: "Doe" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(mockPartyService.createParty).not.toHaveBeenCalled();
    });
  });

  describe("get_party", () => {
    it("should get a party with valid UUID", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("get_party", { partyId: uuid }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.nextActions).toBeDefined();
      expect(mockPartyService.getParty).toHaveBeenCalledWith("tenant-1", uuid);
    });

    it("should reject invalid UUID format", async () => {
      const result = await registry.execute("get_party", { partyId: "not-a-uuid" }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should reject empty partyId", async () => {
      const result = await registry.execute("get_party", { partyId: "" }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
    });
  });

  describe("search_parties", () => {
    it("should search with no filters", async () => {
      const result = await registry.execute("search_parties", {}, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(mockPartyService.searchParties).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-1" })
      );
    });

    it("should search with name filter", async () => {
      await registry.execute("search_parties", { name: "Acme" }, createContext({ partyService: mockPartyService }));

      expect(mockPartyService.searchParties).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Acme", tenantId: "tenant-1" })
      );
    });

    it("should strip HTML from the name filter (matches REST path)", async () => {
      // The MCP search `name` must be HTML-stripped just like the REST
      // SearchPartiesDto (@sanitizeTransform), so a markup payload cannot
      // reach the service/log path intact.
      await registry.execute(
        "search_parties",
        { name: "<script>alert(1)</script>Acme" },
        createContext({ partyService: mockPartyService }),
      );

      expect(mockPartyService.searchParties).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Acme", tenantId: "tenant-1" })
      );
    });

    it("should search with partyType filter", async () => {
      await registry.execute("search_parties", { partyType: "ORGANIZATION" }, createContext({ partyService: mockPartyService }));

      expect(mockPartyService.searchParties).toHaveBeenCalledWith(
        expect.objectContaining({ partyType: "ORGANIZATION" })
      );
    });

    it("should reject whitespace-only name filter instead of silently widening the query", async () => {
      // Regression (round 150): optionalFilteredString normalised "   " to
      // undefined, so search_parties silently returned the UNFILTERED listing
      // while the same request on REST got 422 from requireNonEmptyFilter
      // ("a caller who types '   ' probably meant a real filter, and silently
      // widening the query to 'return all' is a footgun"). Search filters now
      // reject whitespace-only input at the MCP schema layer too, matching
      // the service contract both surfaces share.
      const result = await registry.execute("search_parties", { name: "   " }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(mockPartyService.searchParties).not.toHaveBeenCalled();
    });

    it("should reject whitespace-only roleType filter", async () => {
      const result = await registry.execute("search_parties", { roleType: "   " }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(mockPartyService.searchParties).not.toHaveBeenCalled();
    });

    it("should reject limit below minimum", async () => {
      const result = await registry.execute("search_parties", { limit: 0 }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
    });

    it("should reject limit above maximum", async () => {
      const result = await registry.execute("search_parties", { limit: 999 }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
    });

    it("should show pagination hint when hasMore is true", async () => {
      mockPartyService.searchParties.mockResolvedValueOnce({
        parties: [{ id: "1" }],
        total: 100,
        hasMore: true,
        limit: 50,
        offset: 0,
      });

      const result = await registry.execute("search_parties", {}, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      const paginationHint = result.nextActions?.find((a: string) => a.includes("offset"));
      expect(paginationHint).toBeDefined();
    });

    it("should not show pagination hint when hasMore is false", async () => {
      const result = await registry.execute("search_parties", {}, createContext({ partyService: mockPartyService }));

      const paginationHint = result.nextActions?.find((a: string) => a.includes("offset"));
      expect(paginationHint).toBeUndefined();
    });
  });

  describe("add_party_role", () => {
    it("should add a role with valid input", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_party_role", {
        partyId: uuid,
        roleType: "Customer",
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.nextActions).toBeDefined();
      expect(mockPartyService.addPartyRole).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          partyId: uuid,
          roleType: "Customer",
        })
      );
    });

    it("should reject invalid UUID", async () => {
      const result = await registry.execute("add_party_role", {
        partyId: "bad-uuid",
        roleType: "Customer",
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should reject empty roleType", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_party_role", {
        partyId: uuid,
        roleType: "",
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
    });
  });

  describe("add_contact_mechanism", () => {
    it("should add email with valid input", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "test@example.com" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(mockPartyService.addContactMechanism).toHaveBeenCalled();
    });

    it("should add postal address with valid input", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Springfield",
          country: "US",
        },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
    });

    it("should add telecom number with valid input", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          areaCode: "555",
          lineNumber: "1234567",
        },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
    });

    it("should reject EMAIL_ADDRESS without emailAddress field", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "EMAIL_ADDRESS",
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(result.error?.message).toContain("emailAddress");
    });

    it("should reject POSTAL_ADDRESS without postalAddress field", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "POSTAL_ADDRESS",
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should reject invalid contactMechanismType", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "INVALID_TYPE",
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
    });

    it("should reject invalid UUID", async () => {
      const result = await registry.execute("add_contact_mechanism", {
        partyId: "not-a-uuid",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "test@example.com" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
    });
  });

  describe("response formatting", () => {
    it("should include nextActions in create_party response", async () => {
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "Jane",
        person: { firstName: "Jane", lastName: "Doe" },
      }, createContext({ partyService: mockPartyService }));

      expect(result.nextActions).toBeDefined();
      expect(result.nextActions!.some((a: string) => a.includes("add_party_role"))).toBe(true);
      expect(result.nextActions!.some((a: string) => a.includes("add_contact_mechanism"))).toBe(true);
    });

    it("should include nextActions in get_party response", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("get_party", { partyId: uuid }, createContext({ partyService: mockPartyService }));

      expect(result.nextActions).toBeDefined();
      expect(result.nextActions!.some((a: string) => a.includes("add_party_role"))).toBe(true);
    });
  });

  describe("whitespace-padded fields accepted when trimmed value is within bounds", () => {
    // Regression (round 144): the country, countryCode, and email Zod schemas
    // checked .max() on the RAW input BEFORE the transform ran, so a value like
    // "USA " (4 chars) was rejected even though stripHtmlTags(s.trim().toUpperCase())
    // produces "USA" (3 chars) which is valid. The sanitizedString and
    // optionalFilteredString helpers already length-check AFTER transform, and the
    // REST DTOs trim via @sanitizeTransform before @MaxLength — the MCP path must
    // agree. The pre-transform .max() is removed; the pipe's .max() still enforces
    // the cap on the canonical (trimmed) value.
    it("should accept a whitespace-padded country code that trims within max length", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Springfield",
          country: "USA ",
        },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(mockPartyService.addContactMechanism).toHaveBeenCalledWith(
        expect.objectContaining({
          postalAddress: expect.objectContaining({ country: "USA" }),
        })
      );
    });

    it("should accept a whitespace-padded countryCode that trims within max length", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          areaCode: "555",
          lineNumber: "1234567",
          countryCode: "  +1  ",
        },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(mockPartyService.addContactMechanism).toHaveBeenCalledWith(
        expect.objectContaining({
          telecomNumber: expect.objectContaining({ countryCode: "+1" }),
        })
      );
    });

    it("should strip HTML from an HTML-wrapped countryCode and accept the sanitized value (round-170 REST parity)", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      // Regression: the countryCode transform only trimmed, so "+44<script>…</script>"
      // was rejected on MCP while the identical input was accepted on REST
      // (sanitized to "+44"). The transform now strips HTML like every other
      // string input and like the REST TelecomNumberDto.countryCode.
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          areaCode: "555",
          lineNumber: "1234567",
          countryCode: "+44<script>alert(1)</script>",
        },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(mockPartyService.addContactMechanism).toHaveBeenCalledWith(
        expect.objectContaining({
          telecomNumber: expect.objectContaining({ countryCode: "+44" }),
        })
      );
    });

    it("should normalize an HTML-only countryCode to undefined (service defaults to +1)", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          areaCode: "555",
          lineNumber: "1234567",
          countryCode: "<script>alert(1)</script>",
        },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      const args = mockPartyService.addContactMechanism.mock.calls[0]?.[0] as { telecomNumber?: { countryCode?: string } };
      expect(args.telecomNumber?.countryCode).toBeUndefined();
    });

    it("should accept a whitespace-padded email that trims within max length", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "test@example.com " },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(true);
      expect(mockPartyService.addContactMechanism).toHaveBeenCalledWith(
        expect.objectContaining({
          emailAddress: expect.objectContaining({ email: "test@example.com" }),
        })
      );
    });

    it("should still reject a trimmed value that exceeds max length", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      // "USAX" is 4 chars after trim — exceeds MAX_COUNTRY_CODE_LENGTH (3)
      const result = await registry.execute("add_contact_mechanism", {
        partyId: uuid,
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Springfield",
          country: "USAX",
        },
      }, createContext({ partyService: mockPartyService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });
});
