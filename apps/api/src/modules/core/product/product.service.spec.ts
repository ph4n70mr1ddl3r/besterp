// Unit tests for ProductService
// Tests business logic for product operations.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProductService } from "./product.service.js";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
  ConcurrencyConflictError,
  MAX_FEATURE_NAME_LENGTH,
  MAX_FEATURE_VALUE_LENGTH,
} from "@besterp/shared";

function createMockPrisma() {
  // The tenant-scoped client exposes the model delegates plus an interactive
  // `$transaction`. The write paths (createProduct, addProductFeature,
  // addProductPrice) run their existence check and their insert inside ONE
  // interactive transaction, so the mock must support the callback form:
  // `$transaction(fn)` calls `fn` with a transaction handle that exposes the
  // same delegates.
  const scoped = {
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
  };
  return {
    tenantScoped: vi.fn().mockReturnValue({
      ...scoped,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(scoped)),
    }),
    admin: {
      productType: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
    },
  };
}


/**
 * Build a tenant-scoped client mock whose `$transaction` runs the callback
 * against the supplied delegates.
 */
function scopedClientWith(delegates: Record<string, unknown>) {
  // `addProductFeature` / `addProductPrice` bump the product's version inside
  // the same transaction, so the product delegate always needs an `update`.
  // Provide a default one when the test does not supply it.
  const product = (delegates.product ?? {}) as Record<string, unknown>;
  const withProductUpdate = {
    ...delegates,
    product: {
      update: vi.fn().mockResolvedValue({}),
      ...product,
    },
  };
  return {
    ...withProductUpdate,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(withProductUpdate)),
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

    it("validates productType is non-empty string", async () => {
      await expect(
        service.createProduct({ tenantId: "t1", productType: "", name: "Widget" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("validates productType length", async () => {
      await expect(
        service.createProduct({ tenantId: "t1", productType: "A".repeat(101), name: "Widget" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("validates productType exists", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue(null);
      await expect(
        service.createProduct({ tenantId: "t1", productType: "NONEXISTENT", name: "Widget" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed tenantId in queries", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
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

    it("rejects empty feature name in createProduct", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      prisma.tenantScoped.mockReturnValue({
        $transaction: vi.fn().mockResolvedValue({
          productId: "p1", productTypeId: "pt-1", tenantId: "t1",
          name: "Widget", description: null, sku: null, version: 1,
          createdAt: new Date(), updatedAt: new Date(),
        }),
      });
      await expect(
        service.createProduct({ tenantId: "t1", productType: "GOODS", name: "Widget", features: [{ name: "", value: "Red" }] })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects empty feature value in createProduct", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      prisma.tenantScoped.mockReturnValue({
        $transaction: vi.fn().mockResolvedValue({
          productId: "p1", productTypeId: "pt-1", tenantId: "t1",
          name: "Widget", description: null, sku: null, version: 1,
          createdAt: new Date(), updatedAt: new Date(),
        }),
      });
      await expect(
        service.createProduct({ tenantId: "t1", productType: "GOODS", name: "Widget", features: [{ name: "Color", value: "" }] })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects feature name exceeding max length in createProduct", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      prisma.tenantScoped.mockReturnValue({
        $transaction: vi.fn().mockResolvedValue({
          productId: "p1", productTypeId: "pt-1", tenantId: "t1",
          name: "Widget", description: null, sku: null, version: 1,
          createdAt: new Date(), updatedAt: new Date(),
        }),
      });
      await expect(
        service.createProduct({ tenantId: "t1", productType: "GOODS", name: "Widget", features: [{ name: "x".repeat(MAX_FEATURE_NAME_LENGTH + 1), value: "Red" }] })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a non-string feature name in createProduct", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      await expect(
        service.createProduct({ tenantId: "t1", productType: "GOODS", name: "Widget", features: [{ name: 42 as unknown as string, value: "Red" }] })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a non-string feature value in createProduct", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      await expect(
        service.createProduct({ tenantId: "t1", productType: "GOODS", name: "Widget", features: [{ name: "Color", value: 42 as unknown as string }] })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a categoryId that is not a UUID", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      await expect(
        service.createProduct({ tenantId: "t1", productType: "GOODS", name: "Widget", categoryId: "not-a-uuid" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a categoryId that belongs to another tenant", async () => {
      // Postgres runs foreign-key checks with the table owner's rights, which
      // bypass RLS — so the category ownership must be verified explicitly,
      // otherwise a product could be linked to another tenant's category.
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      prisma.tenantScoped.mockReturnValue({
        $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
          productCategory: { findFirst: vi.fn().mockResolvedValue(null) },
          product: { create: vi.fn() },
        })),
      });
      await expect(
        service.createProduct({
          tenantId: "t1", productType: "GOODS", name: "Widget",
          categoryId: "12345678-1234-1234-1234-123456789abc",
        })
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("links a category that belongs to the tenant", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      const create = vi.fn().mockResolvedValue({
        productId: "p1", productTypeId: "pt-1", tenantId: "t1",
        name: "Widget", description: null, sku: null, version: 1,
        createdAt: new Date(), updatedAt: new Date(),
      });
      prisma.tenantScoped.mockReturnValue({
        $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
          productCategory: { findFirst: vi.fn().mockResolvedValue({ productCategoryId: "12345678-1234-1234-1234-123456789abc" }) },
          product: { create },
        })),
      });

      await service.createProduct({
        tenantId: "t1", productType: "GOODS", name: "Widget",
        categoryId: "12345678-1234-1234-1234-123456789abc",
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            category: { connect: { productCategoryId: "12345678-1234-1234-1234-123456789abc" } },
          }),
        })
      );
    });

    it("rejects feature value exceeding max length in createProduct", async () => {
      prisma.admin.productType.findFirst.mockResolvedValue({ productTypeId: "pt-1" });
      prisma.tenantScoped.mockReturnValue({
        $transaction: vi.fn().mockResolvedValue({
          productId: "p1", productTypeId: "pt-1", tenantId: "t1",
          name: "Widget", description: null, sku: null, version: 1,
          createdAt: new Date(), updatedAt: new Date(),
        }),
      });
      await expect(
        service.createProduct({ tenantId: "t1", productType: "GOODS", name: "Widget", features: [{ name: "Color", value: "x".repeat(MAX_FEATURE_VALUE_LENGTH + 1) }] })
      ).rejects.toThrow(InvalidTypeValueError);
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
      prisma.tenantScoped.mockReturnValue(scopedClientWith({
        product: { findUnique: vi.fn().mockResolvedValue(null) },
      }));
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

    it("returns null productType when product has no type", async () => {
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
      const result = await service.getProduct("t1", "12345678-1234-1234-1234-123456789abc");
      expect(result.productType).toBeNull();
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
      prisma.admin.productType.findFirst.mockResolvedValue(null);
      await expect(
        service.updateProduct({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", productType: "BAD" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("increments the version on every update", async () => {
      // The `version` column existed but was never incremented, so it could
      // never detect a concurrent write.
      const update = vi.fn().mockResolvedValue({
        productId: "12345678-1234-1234-1234-123456789abc",
        productTypeId: "pt-1",
        tenantId: "t1",
        name: "New",
        description: null,
        sku: null,
        version: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      prisma.tenantScoped.mockReturnValue({ product: { update } });

      const result = await service.updateProduct({
        tenantId: "t1",
        productId: "12345678-1234-1234-1234-123456789abc",
        name: "New",
      });

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ version: { increment: 1 } }) }),
      );
      expect(result.version).toBe(2);
    });

    it("predicates the update on expectedVersion when one is supplied", async () => {
      const update = vi.fn().mockResolvedValue({
        productId: "12345678-1234-1234-1234-123456789abc",
        productTypeId: "pt-1",
        tenantId: "t1",
        name: "New",
        description: null,
        sku: null,
        version: 4,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      prisma.tenantScoped.mockReturnValue({ product: { update } });

      await service.updateProduct({
        tenantId: "t1",
        productId: "12345678-1234-1234-1234-123456789abc",
        name: "New",
        expectedVersion: 3,
      });

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ version: 3 }),
        }),
      );
    });

    it("rejects a non-positive or fractional expectedVersion", async () => {
      for (const expectedVersion of [0, -1, 1.5]) {
        await expect(
          service.updateProduct({
            tenantId: "t1",
            productId: "12345678-1234-1234-1234-123456789abc",
            name: "New",
            expectedVersion,
          })
        ).rejects.toThrow(InvalidTypeValueError);
      }
    });

    it("reports a lost-update conflict when the version predicate misses", async () => {
      // The write is predicated on the version the caller read, but somebody
      // else changed the row first: the update misses, and the caller must be
      // told it is a CONFLICT (not "not found" — the product is still there).
      const update = vi.fn().mockRejectedValue(
        Object.assign(new Error("Record to update not found."), { code: "P2025" }),
      );
      const findUnique = vi.fn().mockResolvedValue({ productId: "12345678-1234-1234-1234-123456789abc" });
      prisma.tenantScoped.mockReturnValue({ product: { update, findUnique } });

      await expect(
        service.updateProduct({
          tenantId: "t1",
          productId: "12345678-1234-1234-1234-123456789abc",
          name: "New",
          expectedVersion: 3,
        })
      ).rejects.toThrow(ConcurrencyConflictError);
    });

    it("reports a missing product as not-found when the row does not exist", async () => {
      const update = vi.fn().mockRejectedValue(
        Object.assign(new Error("Record to update not found."), { code: "P2025" }),
      );
      const findUnique = vi.fn().mockResolvedValue(null);
      prisma.tenantScoped.mockReturnValue({ product: { update, findUnique } });

      await expect(
        service.updateProduct({
          tenantId: "t1",
          productId: "12345678-1234-1234-1234-123456789abc",
          name: "New",
          expectedVersion: 3,
        })
      ).rejects.toThrow(EntityNotFoundError);
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
      prisma.tenantScoped.mockReturnValue(scopedClientWith({
        product: { findUnique: vi.fn().mockResolvedValue(null) },
      }));
      await expect(
        service.addProductFeature({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", name: "Color", value: "Red" })
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("bumps the product version", async () => {
      // A feature IS part of the product's effective content, so the
      // optimistic-concurrency token must move with it. Without the bump, a
      // caller that read the product, then had a feature added, and then
      // wrote back the version it read was ACCEPTED — the version was not a
      // reliable token for the aggregate the tools actually mutate.
      const update = vi.fn().mockResolvedValue({});
      prisma.tenantScoped.mockReturnValue(scopedClientWith({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }), update },
        productFeature: { create: vi.fn().mockResolvedValue({
          productFeatureId: "pf1", productId: "p1", name: "Color", value: "Red", createdAt: new Date(),
        }) },
      }));
      await service.addProductFeature({
        tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", name: "Color", value: "Red",
      });
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        data: { version: { increment: 1 } },
      }));
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
      prisma.tenantScoped.mockReturnValue(scopedClientWith({
        product: { findUnique: vi.fn().mockResolvedValue(null) },
      }));
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: 10 })
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("rejects invalid fromDate", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
        productPrice: { create: vi.fn() },
      });
      // The date is validated with isValidISODate BEFORE it is parsed, so an
      // unparseable value produces the structured InvalidTypeValueError (not
      // a plain Error that surfaced as an opaque INTERNAL_ERROR).
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: 10, fromDate: "not-a-date" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a calendar-invalid date that Date would silently roll over", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
        productPrice: { create: vi.fn() },
      });
      // "2024-06-31" is not a real date — `new Date("2024-06-31")` silently
      // rolls over to 2024-07-01, storing a DIFFERENT day than requested.
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: 10, fromDate: "2024-06-31" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a null currencyCode-free price with a non-string priceType", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
        productPrice: { create: vi.fn() },
      });
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: 42 as unknown as string, amount: 10 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("bumps the product version", async () => {
      // A price is part of the product's effective content too — see the
      // equivalent note in the addProductFeature test.
      const update = vi.fn().mockResolvedValue({});
      prisma.tenantScoped.mockReturnValue(scopedClientWith({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }), update },
        productPrice: { create: vi.fn().mockResolvedValue({
          productPriceId: "pp1", productId: "p1", priceType: "LIST", amount: 10,
          currencyCode: "USD", fromDate: new Date(), thruDate: null, createdAt: new Date(),
        }) },
      }));
      await service.addProductPrice({
        tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: 10,
      });
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        data: { version: { increment: 1 } },
      }));
    });

    it("defaults a null currencyCode to the default currency", async () => {
      const create = vi.fn().mockResolvedValue({
        productPriceId: "pp1", productId: "p1", priceType: "LIST", amount: 10,
        currencyCode: "USD", fromDate: new Date(), thruDate: null, createdAt: new Date(),
      });
      prisma.tenantScoped.mockReturnValue(scopedClientWith({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
        productPrice: { create },
      }));
      await service.addProductPrice({
        tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc",
        priceType: "LIST", amount: 10, currencyCode: null as unknown as string,
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ currencyCode: "USD" }) })
      );
    });

    it("rejects NaN amount with InvalidTypeValueError", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
      });
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: NaN })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects an overly long priceType with InvalidTypeValueError", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
      });
      // Zod schema (product-tools.ts) caps priceType at 50 chars, but direct
      // callers bypass Zod — this is the service-layer last line of defense.
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "A".repeat(51), amount: 10 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects Infinity amount with InvalidTypeValueError", async () => {
      prisma.tenantScoped.mockReturnValue({
        product: { findUnique: vi.fn().mockResolvedValue({ productId: "p1" }) },
      });
      await expect(
        service.addProductPrice({ tenantId: "t1", productId: "12345678-1234-1234-1234-123456789abc", priceType: "LIST", amount: Infinity })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("throws InvalidTypeValueError when price amount has unexpected DB type", async () => {
      // Regression (round 210): the toPriceResult/toGetProductResult helpers used
      // `parseFloat(String(pr.amount)) || 0` which silently masked data corruption
      // by returning 0 for any invalid amount type. Now they throw instead.
      prisma.tenantScoped.mockReturnValue({
        product: {
          findUnique: vi.fn().mockResolvedValue({
            productId: "p1",
            productTypeId: "pt1",
            tenantId: "t1",
            name: "Widget",
            description: null,
            sku: null,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            productType: null,
            features: [],
            prices: [{ priceType: "LIST", amount: "corrupted", currencyCode: "USD", fromDate: new Date(), thruDate: null }],
            category: null,
          }),
        },
      });
      await expect(
        service.getProduct("t1", "12345678-1234-1234-1234-123456789abc")
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("maps a Prisma Decimal price amount to a number", async () => {
      // `product_price.amount` is `Decimal @db.Decimal(19, 4)`, which Prisma
      // returns as a `Prisma.Decimal` OBJECT — never a JS number. The mapper
      // used `typeof value === "number"`, so the numeric branch was never
      // taken for a real row: `get_product` threw for EVERY product that had
      // a price, and `add_product_price` wrote the row and then threw (so the
      // agent was told the write failed although it had been persisted, and a
      // retry under the same idempotency key created a DUPLICATE row).
      // The existing specs missed it because the mocks used plain numbers.
      class FakeDecimal {
        constructor(private readonly value: number) {}
        toNumber(): number { return this.value; }
        toString(): string { return String(this.value); }
      }
      prisma.tenantScoped.mockReturnValue({
        product: {
          findUnique: vi.fn().mockResolvedValue({
            productId: "p1",
            productTypeId: "pt1",
            tenantId: "t1",
            name: "Widget",
            description: null,
            sku: null,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            productType: null,
            features: [],
            prices: [{ priceType: "LIST", amount: new FakeDecimal(19.99), currencyCode: "USD", fromDate: new Date(), thruDate: null }],
            category: null,
          }),
        },
      });
      const result = await service.getProduct("t1", "12345678-1234-1234-1234-123456789abc");
      expect(result.prices[0]!.amount).toBe(19.99);
    });

    it("rejects a price whose thruDate is not after its fromDate", async () => {
      await expect(
        service.addProductPrice({
          tenantId: "t1",
          productId: "12345678-1234-1234-1234-123456789abc",
          priceType: "LIST",
          amount: 10,
          fromDate: "2024-06-15",
          thruDate: "2024-06-01",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a currency code that is not three letters", async () => {
      await expect(
        service.addProductPrice({
          tenantId: "t1",
          productId: "12345678-1234-1234-1234-123456789abc",
          priceType: "LIST",
          amount: 10,
          currencyCode: "1US",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a create_product call with too many features", async () => {
      await expect(
        service.createProduct({
          tenantId: "t1",
          productType: "GOOD",
          name: "Widget",
          features: Array.from({ length: 51 }, (_, i) => ({ name: `f${i}`, value: "v" })),
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });
  });
});
