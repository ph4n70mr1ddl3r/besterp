// Unit tests for PartyController
// Tests REST endpoint behavior: tenant context extraction, error handling, delegation

import { describe, it, expect, beforeEach, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { PartyController } from "./party.controller.js";
import { PartyService } from "./party.service.js";

function mockRequest(tenantContext?: any) {
  return { user: { userId: "user-1", tenantId: "tenant-1" }, tenantContext } as any;
}

function mockRequestNoContext() {
  return {} as any;
}

describe("PartyController", () => {
  let controller: PartyController;
  let partyService: PartyService;

  beforeEach(() => {
    partyService = {
      createParty: vi.fn().mockResolvedValue({ partyId: "p1" }),
      getParty: vi.fn().mockResolvedValue({ partyId: "p1", name: "Test" }),
      searchParties: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }),
      addPartyRole: vi.fn().mockResolvedValue({ partyRoleId: "r1" }),
      addContactMechanism: vi.fn().mockResolvedValue({ contactMechanismId: "c1" }),
    } as any;

    controller = new PartyController(partyService);
  });

  describe("getTenantContext", () => {
    it("should extract tenant context from request", async () => {
      const req = mockRequest({ tenantId: "tenant-1", userId: "user-1" });
      // create() internally calls getTenantContext
      await controller.create(req, { partyType: "PERSON", name: "Test", person: { firstName: "A", lastName: "B" } } as any);
      expect(partyService.createParty).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-1" })
      );
    });

    it("should throw UnauthorizedException when tenant context is missing", async () => {
      const req = mockRequestNoContext();
      await expect(
        controller.create(req, {} as any)
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw UnauthorizedException when tenant context has no tenantId", async () => {
      const req = mockRequest({ userId: "user-1" }); // no tenantId
      await expect(
        controller.create(req, {} as any)
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("create", () => {
    it("should spread body and inject tenantId from context", async () => {
      const req = mockRequest({ tenantId: "tenant-1", userId: "user-1" });
      const body = { partyType: "PERSON" as const, name: "Test", person: { firstName: "A", lastName: "B" } };

      await controller.create(req, body as any);

      expect(partyService.createParty).toHaveBeenCalledWith({
        ...body,
        tenantId: "tenant-1",
      });
    });

    it("should guarantee tenantId from JWT even if body includes one", async () => {
      const req = mockRequest({ tenantId: "tenant-1", userId: "user-1" });
      const body = { partyType: "PERSON" as const, name: "Test", tenantId: "evil-tenant" } as any;

      await controller.create(req, body);

      // tenantId placed after spread guarantees JWT context wins
      expect(partyService.createParty).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-1" })
      );
    });
  });

  describe("search", () => {
    it("should pass tenantId and query params to service", async () => {
      const req = mockRequest({ tenantId: "tenant-1", userId: "user-1" });
      const query = { name: "Test", limit: 10, offset: 5 };

      await controller.search(req, query as any);

      expect(partyService.searchParties).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        name: "Test",
        limit: 10,
        offset: 5,
      });
    });

    it("should default limit and offset when not provided", async () => {
      const req = mockRequest({ tenantId: "tenant-1", userId: "user-1" });
      const query = {};

      await controller.search(req, query as any);

      expect(partyService.searchParties).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50, offset: 0 })
      );
    });
  });

  describe("get", () => {
    it("should pass tenantId and partyId to service", async () => {
      const req = mockRequest({ tenantId: "tenant-1", userId: "user-1" });

      await controller.get(req, "party-123");

      expect(partyService.getParty).toHaveBeenCalledWith("tenant-1", "party-123");
    });
  });

  describe("addRole", () => {
    it("should inject tenantId and partyId from route params", async () => {
      const req = mockRequest({ tenantId: "tenant-1", userId: "user-1" });
      const body = { roleType: "Customer" };

      await controller.addRole(req, "party-123", body as any);

      expect(partyService.addPartyRole).toHaveBeenCalledWith({
        roleType: "Customer",
        tenantId: "tenant-1",
        partyId: "party-123",
      });
    });
  });

  describe("addContact", () => {
    it("should inject tenantId and partyId from route params", async () => {
      const req = mockRequest({ tenantId: "tenant-1", userId: "user-1" });
      const body = { contactMechanismType: "EMAIL_ADDRESS", emailAddress: { email: "a@b.com" } };

      await controller.addContact(req, "party-123", body as any);

      expect(partyService.addContactMechanism).toHaveBeenCalledWith({
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "a@b.com" },
        tenantId: "tenant-1",
        partyId: "party-123",
      });
    });
  });
});
