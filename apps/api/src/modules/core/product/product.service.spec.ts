// Unit tests for ProductService
// Tests business logic for product operations.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProductService } from "./product.service.js";
import {
  InvalidTypeValueError,
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
  });
});
