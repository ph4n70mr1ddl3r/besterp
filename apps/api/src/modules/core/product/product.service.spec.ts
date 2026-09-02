// Unit tests for ProductService
// Tests business logic for product operations.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProductService } from "./product.service.js";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
} from "@besterp/shared";

function createMockPrisma() {
  return {
    tenantScoped: vi.fn().mockReturnValue({
      product: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      productFeature: {
        create: vi.fn(),
      },
      productPrice: {
        create: vi.fn(),
      },
    }),
    admin: {
      productType: {
        findUnique: vi.fn(),
      },
    },
  };
}

describe("ProductService", () => {
  let service: ProductService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new ProductService(prisma as unknown as import("../../../prisma/prisma.service.js").PrismaService);
  });

  describe("createProduct", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.createProduct({ tenantId: "", productType: "GOODS", name: "Widget" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("validates name is non-empty", async () => {
      await expect(
        service.createProduct({ tenantId: "t1", productType: "GOODS", name: "" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("validates productType exists", async () => {
      prisma.admin.productType.findUnique.mockResolvedValue(null);
      await expect(
        service.createProduct({ tenantId: "t1", productType: "NONEXISTENT", name: "Widget" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed tenantId in queries", async () => {
      prisma.admin.productType.findUnique.mockResolvedValue({ productTypeId: "pt-1" });
      prisma.tenantScoped.mockReturnValue({
        $transaction: vi.fn().mockResolvedValue({
          productId: "p1", productTypeId: "pt-1", tenantId: "t1",
          name: "Widget", description: null, sku: null, version: 1,
          createdAt: new Date(), updatedAt: new Date(),
        }),
      });

      await service.createProduct({ tenantId: " t1 ", productType: "GOODS", name: " Widget " });
      expect(prisma.tenantScoped).toHaveBeenCalledWith("t1");
    });
  });

  describe("getProduct", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.getProduct("", "12345678-1234-1234-1234-123456789abc")
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-UUID productId", async () => {
      await expect(
        service.getProduct("t1", "not-a-uuid")
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("returns EntityNotFoundError when product not found", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue(null) },
      });
      await expect(
        service.getProduct("t1", "12345678-1234-1234-1234-123456789abc")
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("uses trimmed productId in queries", async () => {
      const mockClient = {
        product: {
          findUnique: vi.fn().mockResolvedValue({
            productId: "p1", productTypeId: "pt-1", tenantId: "t1",
            name: "Widget", description: null, sku: null, version: 1,
            createdAt: new Date(), updatedAt: new Date(),
            productType: null, features: [], prices: [], category: null,
          }),
        },
      };
      prisma.tenantScoped.mockReturnValue(mockClient);
      await service.getProduct("t1", " 12345678-1234-1234-1234-123456789abc ");
      expect(mockClient.product.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ productId: "12345678-1234-1234-1234-123456789abc" }) })
      );
    });
  });

  describe("searchProducts", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.searchProducts({ tenantId: "" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("clamps limit and offset to valid ranges", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: {
          count: vi.fn().mockResolvedValue(5),
          findMany: vi.fn().mockResolvedValue([]),
        },
      });

      const result = await service.searchProducts({ tenantId: "t1", limit: 999, offset: 99999 });
      expect(result.limit).toBe(500);
      expect(result.offset).toBe(10000);
      expect(result.hasMore).toBe(false);
    });

    it("uses validated pagination in queries", async () => {
      const mockClient = {
        product: {
          count: vi.fn().mockResolvedValue(10),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      prisma.tenantScoped.mockReturnValue(mockClient);

      await service.searchProducts({ tenantId: "t1", limit: 10, offset: 5 });
      expect(mockClient.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 10 })
      );
    });

    it("rejects NaN limit with InvalidTypeValueError", async () => {
      await expect(
        service.searchProducts({ tenantId: "t1", limit: NaN, offset: 0 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-integer limit with InvalidTypeValueError", async () => {
      await expect(
        service.searchProducts({ tenantId: "t1", limit: 12.5, offset: 0 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects Infinity offset with InvalidTypeValueError", async () => {
      await expect(
        service.searchProducts({ tenantId: "t1", limit: 10, offset: Infinity })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects whitespace-only name filter", async () => {
      await expect(
        service.searchProducts({ tenantId: "t1", name: "   " })
      ).rejects.toThrow(InvalidTypeValueError);
    });
  });

  describe("updateProduct", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.updateProduct({ tenantId: "", productId: "12345678-1234-1234-1234-123456789abc", name: "New" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-UUID productId", async () => {
      await expect(
        service.updateProduct({ tenantId: "t1", productId: "bad", name: "New" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("throws when no update fields provided", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { update: vi.fn() },
      });
      await expect(
        service.updateProduct({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("validates productType when provided", async () => {
      prisma.admin.productType.findUnique.mockResolvedValue(null);
      await expect(
        service.updateProduct({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", productTypeId: "BAD" })
      ).rejects.toThrow(InvalidTypeValueError);
    });
  });

  describe("addProductFeature", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.addProductFeature({ tenantId: "", productId: "12345678-1234-1234-1234-123456789abc", name: "Color", value: "Red" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-UUID productId", async () => {
      await expect(
        service.addProductFeature({ tenantId: "t1", productId: "bad", name: "Color", value: "Red" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects empty feature name", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
        productFeature: { create: vi.fn() },
      });
      await expect(
        service.addProductFeature({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", name: "", value: "Red" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("returns EntityNotFoundError when product not found", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue(null) },
      });
      await expect(
        service.addProductFeature({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", name: "Color", value: "Red" })
      ).rejects.toThrow(EntityNotFoundError);
    });
  });

  describe("addProductPrice", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.addProductPrice({ tenantId: "", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: 10 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-UUID productId", async () => {
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "bad", priceType: "LIST", amount: 10 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-positive amount", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
      });
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: 0 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects negative amount", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
      });
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: -5 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("returns EntityNotFoundError when product not found", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue(null) },
      });
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: 10 })
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("rejects invalid fromDate", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
        productPrice: { create: vi.fn() },
      });
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: 10, fromDate: "not-a-date" })
      ).rejects.toThrow("Invalid ISO date string");
    });
  });
});
