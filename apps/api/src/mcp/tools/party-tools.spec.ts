// Unit tests for Party MCP Tools.
// Tests tool definitions, input validation, and error handling.

import { z } from "zod";
import { ToolRegistry } from "@besterp/mcp-tools";
import { registerPartyTools } from "./party-tools";
import type {
  CreatePartyInput,
  SearchPartiesInput,
  AddPartyRoleInput,
  AddContactMechanismInput,
} from "../../modules/core/party/party.types";

describe("Party Tools", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerPartyTools(registry);
  });

  describe("create_party tool", () => {
    const tool = registry.get("create_party");
    if (!tool) {
      throw new Error("create_party tool not found in registry");
    }

    it("should have correct definition", () => {
      expect(tool.definition.name).toBe("create_party");
      expect(tool.definition.riskLevel).toBe("low");
      expect(tool.definition.entity).toBe("party");
      expect(tool.definition.tags).toContain("party");
      expect(tool.definition.tags).toContain("create");
    });

    it("should validate required fields", async () => {
      const validInput = {
        partyType: "PERSON",
        name: "John Doe",
        person: { firstName: "John", lastName: "Doe" },
      };

      const result = await tool.definition.handler(validInput, {
        tenantId: "tenant-1",
        services: {
          partyService: {
            createParty: jest.fn().mockResolvedValue({
              partyId: "123",
              name: "John Doe",
              person: { firstName: "John", lastName: "Doe" },
            }),
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.name).toBe("John Doe");
    });

    it("should reject invalid partyType", async () => {
      const invalidInput = {
        partyType: "INVALID_TYPE" as const,
        name: "John Doe",
        person: { firstName: "John", lastName: "Doe" },
      };

      await expect(
        tool.definition.handler(invalidInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).rejects.toThrow();
    });

    it("should require person data for PERSON type", async () => {
      const invalidInput = {
        partyType: "PERSON",
        name: "John Doe",
        // Missing person data
      };

      await expect(
        tool.definition.handler(invalidInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).rejects.toThrow();
    });

    it("should require organization data for ORGANIZATION type", async () => {
      const invalidInput = {
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        // Missing organization data
      };

      await expect(
        tool.definition.handler(invalidInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).rejects.toThrow();
    });

    it("should reject empty name", async () => {
      const invalidInput = {
        partyType: "PERSON",
        name: "",
        person: { firstName: "John", lastName: "Doe" },
      };

      await expect(
        tool.definition.handler(invalidInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).rejects.toThrow();
    });
  });

  describe("get_party tool", () => {
    const tool = registry.get("get_party");
    if (!tool) {
      throw new Error("get_party tool not found in registry");
    }

    it("should have correct definition", () => {
      expect(tool.definition.name).toBe("get_party");
      expect(tool.definition.riskLevel).toBe("none");
      expect(tool.definition.entity).toBe("party");
    });

    it("should validate partyId format", async () => {
      const validInput = { partyId: "123-abc" };

      const result = await tool.definition.handler(validInput, {
        tenantId: "tenant-1",
        services: {
          partyService: {
            getParty: jest.fn().mockResolvedValue({
              partyId: "123-abc",
              name: "Test Party",
            }),
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.partyId).toBe("123-abc");
    });
  });

  describe("search_parties tool", () => {
    const tool = registry.get("search_parties");
    if (!tool) {
      throw new Error("search_parties tool not found in registry");
    }

    it("should have correct definition", () => {
      expect(tool.definition.name).toBe("search_parties");
      expect(tool.definition.riskLevel).toBe("none");
      expect(tool.definition.entity).toBe("party");
    });

    it("should accept all optional fields", async () => {
      const input = {
        name: "Test",
        partyType: "PERSON",
        roleType: "Customer",
        limit: 25,
        offset: 10,
      };

      const result = await tool.definition.handler(input, {
        tenantId: "tenant-1",
        services: {
          partyService: {
            searchParties: jest.fn().mockResolvedValue({
              items: [],
              total: 0,
              limit: 25,
              offset: 10,
              hasMore: false,
            }),
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(25);
      expect(result.data.offset).toBe(10);
    });

    it("should use defaults when fields are missing", async () => {
      const input = {}; // No optional fields

      const result = await tool.definition.handler(input, {
        tenantId: "tenant-1",
        services: {
          partyService: {
            searchParties: jest.fn().mockResolvedValue({
              items: [],
              total: 0,
              limit: 50,
              offset: 0,
              hasMore: false,
            }),
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    });

    it("should validate limit range", async () => {
      const invalidInput = {
        limit: 1000, // Exceeds max of 500
      };

      await expect(
        tool.definition.handler(invalidInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).rejects.toThrow();
    });
  });

  describe("add_party_role tool", () => {
    const tool = registry.get("add_party_role");
    if (!tool) {
      throw new Error("add_party_role tool not found in registry");
    }

    it("should have correct definition", () => {
      expect(tool.definition.name).toBe("add_party_role");
      expect(tool.definition.riskLevel).toBe("low");
      expect(tool.definition.entity).toBe("party");
      expect(tool.definition.tags).toContain("role");
    });

    it("should validate required fields", async () => {
      const validInput = {
        idempotencyKey: "role-123-customer-2024",
        partyId: "123",
        roleType: "Customer",
      };

      const result = await tool.definition.handler(validInput, {
        tenantId: "tenant-1",
        services: {
          partyService: {
            addPartyRole: jest.fn().mockResolvedValue({
              partyRoleId: "role-123",
              partyId: "123",
              roleTypeName: "Customer",
              fromDate: new Date().toISOString(),
              thruDate: null,
            }),
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.roleTypeName).toBe("Customer");
    });

    it("should reject empty roleType", async () => {
      const invalidInput = {
        partyId: "123",
        roleType: "",
      };

      await expect(
        tool.definition.handler(invalidInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).rejects.toThrow();
    });

    it("should validate idempotency key format", async () => {
      const validInput = {
        idempotencyKey: "role-123-customer-2024",
        partyId: "123",
        roleType: "Customer",
      };

      await expect(
        tool.definition.handler(validInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).resolves.not.toThrow();
    });
  });

  describe("add_contact_mechanism tool", () => {
    const tool = registry.get("add_contact_mechanism");
    if (!tool) {
      throw new Error("add_contact_mechanism tool not found in registry");
    }

    it("should have correct definition", () => {
      expect(tool.definition.name).toBe("add_contact_mechanism");
      expect(tool.definition.riskLevel).toBe("low");
      expect(tool.definition.entity).toBe("party");
      expect(tool.definition.tags).toContain("contact");
    });

    it("should validate postal address format", async () => {
      const validInput = {
        idempotencyKey: "contact-123-address-2024",
        partyId: "123",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          country: "US",
        },
      };

      const result = await tool.definition.handler(validInput, {
        tenantId: "tenant-1",
        services: {
          partyService: {
            addContactMechanism: jest.fn().mockResolvedValue({
              contactMechanismId: "addr-123",
              contactMechanismType: "POSTAL_ADDRESS",
              partyId: "123",
              postalAddress: {
                addressLine1: "123 Main St",
                city: "Anytown",
                country: "US",
              },
            }),
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.contactMechanismType).toBe("POSTAL_ADDRESS");
    });

    it("should validate email format", async () => {
      const validInput = {
        idempotencyKey: "contact-123-email-2024",
        partyId: "123",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "test@example.com" },
      };

      const result = await tool.definition.handler(validInput, {
        tenantId: "tenant-1",
        services: {
          partyService: {
            addContactMechanism: jest.fn().mockResolvedValue({
              contactMechanismId: "email-123",
              contactMechanismType: "EMAIL_ADDRESS",
              partyId: "123",
              emailAddress: { email: "test@example.com" },
            }),
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.emailAddress?.email).toBe("test@example.com");
    });

    it("should reject invalid email format", async () => {
      const invalidInput = {
        partyId: "123",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "invalid-email" },
      };

      await expect(
        tool.definition.handler(invalidInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).rejects.toThrow();
    });

    it("should require subtype data based on contact type", async () => {
      // Missing required postal address fields
      const invalidInput = {
        partyId: "123",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "", // Empty should cause error
          city: "Anytown",
          country: "US",
        },
      };

      await expect(
        tool.definition.handler(invalidInput, {
          tenantId: "tenant-1",
          services: { partyService: {} },
        })
      ).rejects.toThrow();
    });
  });

  describe("Tool registration", () => {
    it("should register all party tools", () => {
      const tools = registry.names;
      expect(tools).toContain("create_party");
      expect(tools).toContain("get_party");
      expect(tools).toContain("search_parties");
      expect(tools).toContain("add_party_role");
      expect(tools).toContain("add_contact_mechanism");
    });

    it("should have correct number of tools", () => {
      expect(registry.names).toHaveLength(5);
    });
  });

  describe("Error handling", () => {
    it("should handle service errors gracefully", async () => {
      const tool = registry.get("create_party");
      if (!tool) throw new Error("Tool not found");

      // Mock service to throw an error
      await expect(
        tool.definition.handler(
          {
            partyType: "PERSON",
            name: "John Doe",
            person: { firstName: "John", lastName: "Doe" },
          },
          {
            tenantId: "tenant-1",
            services: {
              partyService: {
                createParty: jest.fn().mockRejectedValue(new Error("Service error")),
              },
            },
          }
        )
      ).rejects.toThrow("Service error");
    });
  });
});