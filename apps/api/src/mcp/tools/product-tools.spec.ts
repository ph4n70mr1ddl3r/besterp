// Unit tests for Product MCP Tools

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry, type ToolContext } from "@besterp/mcp-tools";
import { registerProductTools } from "./product-tools.js";

const TEST_TENANT = "tenant-acme";
const TEST_PRODUCT_ID = "550e8400-e29b-41d4-a716-446655440001";

function createMockProductService() {
  return {
    createProduct: vi.fn().mockResolvedValue({
      productId: TEST_PRODUCT_ID,
      productTypeId: "pt-good",
      tenantId: TEST_TENANT,
      name: "Widget A",
      description: "A useful widget",
      sku: "WID-001",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    }),
    getProduct: vi.fn().mockResolvedValue({
      productId: TEST_PRODUCT_ID,
      productTypeId: "pt-good",
      tenantId: TEST_TENANT,
      name: "Widget A",
      description: "A useful widget",
      sku: "WID-001",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      productType: { name: "GOOD", description: null },
      features: [],
      prices: [{ priceType: "LIST", amount: 29.99, currencyCode: "USD", fromDate: "2024-01-01T00:00:00.000Z", thruDate: null }],
      category: null,
    }),
    searchProducts: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    }),
    addProductFeature: vi.fn().mockResolvedValue({
      productFeatureId: "feat-1",
      productId: TEST_PRODUCT_ID,
      name: "color",
      value: "red",
      createdAt: "2024-01-01T00:00:00.000Z",
    }),
    addProductPrice: vi.fn().mockResolvedValue({
      productPriceId: "price-1",
      productId: TEST_PRODUCT_ID,
      priceType: "LIST",
      amount: 29.99,
      currencyCode: "USD",
      fromDate: "2024-01-01T00:00:00.000Z",
      thruDate: null,
      createdAt: "2024-01-01T00:00:00.000Z",
    }),
  };
}

function createContext(services: Record<string, unknown> = {}): ToolContext {
  return {
    tenantId: TEST_TENANT,
    userId: "user-1",
    services,
  };
}

describe("Product MCP Tools", () => {
  let registry: ToolRegistry;
  let mockProductService: ReturnType<typeof createMockProductService>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
    mockProductService = createMockProductService();
    registerProductTools(registry);
  });

  describe("registration", () => {
    it("should register all five product tools", () => {
      expect(registry.names).toContain("create_product");
      expect(registry.names).toContain("get_product");
      expect(registry.names).toContain("search_products");
      expect(registry.names).toContain("add_product_feature");
      expect(registry.names).toContain("add_product_price");
    });
  });

  describe("create_product", () => {
    it("should create a product with valid input", async () => {
      const result = await registry.execute("create_product", {
        productType: "GOOD",
        name: "Widget A",
        sku: "WID-001",
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(mockProductService.createProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TEST_TENANT,
          productType: "GOOD",
          name: "Widget A",
          sku: "WID-001",
        })
      );
    });

    it("should reject missing name", async () => {
      const result = await registry.execute("create_product", {
        productType: "GOOD",
        sku: "WID-001",
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should strip HTML from name", async () => {
      await registry.execute("create_product", {
        productType: "GOOD",
        name: "<script>alert(1)</script>Widget A",
      }, createContext({ productService: mockProductService }));

      expect(mockProductService.createProduct).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Widget A" })
      );
    });

    it("should accept optional features", async () => {
      await registry.execute("create_product", {
        productType: "GOOD",
        name: "Widget A",
        features: [{ name: "color", value: "red" }, { name: "size", value: "large" }],
      }, createContext({ productService: mockProductService }));

      expect(mockProductService.createProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          features: [{ name: "color", value: "red" }, { name: "size", value: "large" }],
        })
      );
    });
  });

  describe("get_product", () => {
    it("should get a product by ID", async () => {
      const result = await registry.execute("get_product", {
        productId: TEST_PRODUCT_ID,
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(mockProductService.getProduct).toHaveBeenCalledWith(TEST_TENANT, TEST_PRODUCT_ID);
    });

    it("should reject invalid productId", async () => {
      const result = await registry.execute("get_product", {
        productId: "not-a-uuid",
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });

  describe("search_products", () => {
    it("should search products with no filters", async () => {
      const result = await registry.execute("search_products", {}, createContext({ productService: mockProductService }));

      expect(result.success).toBe(true);
      expect(mockProductService.searchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TEST_TENANT })
      );
    });

    it("should filter by name", async () => {
      await registry.execute("search_products", { name: "Widget" }, createContext({ productService: mockProductService }));

      expect(mockProductService.searchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Widget", tenantId: TEST_TENANT })
      );
    });

    it("should filter by productType", async () => {
      await registry.execute("search_products", { productType: "GOOD" }, createContext({ productService: mockProductService }));

      expect(mockProductService.searchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ productType: "GOOD", tenantId: TEST_TENANT })
      );
    });

    it("should reject whitespace-only name filter", async () => {
      const result = await registry.execute("search_products", { name: "   " }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should respect pagination limits", async () => {
      await registry.execute("search_products", { limit: 10, offset: 5 }, createContext({ productService: mockProductService }));

      expect(mockProductService.searchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 5, tenantId: TEST_TENANT })
      );
    });
  });

  describe("add_product_feature", () => {
    it("should add a feature to a product", async () => {
      const result = await registry.execute("add_product_feature", {
        productId: TEST_PRODUCT_ID,
        name: "color",
        value: "red",
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(true);
      expect(mockProductService.addProductFeature).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TEST_TENANT, productId: TEST_PRODUCT_ID, name: "color", value: "red" })
      );
    });

    it("should reject invalid productId", async () => {
      const result = await registry.execute("add_product_feature", {
        productId: "bad-id",
        name: "color",
        value: "red",
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });

  describe("add_product_price", () => {
    it("should add a price to a product", async () => {
      const result = await registry.execute("add_product_price", {
        productId: TEST_PRODUCT_ID,
        priceType: "LIST",
        amount: 29.99,
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(true);
      expect(mockProductService.addProductPrice).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TEST_TENANT, productId: TEST_PRODUCT_ID, priceType: "LIST", amount: 29.99, currencyCode: "USD" })
      );
    });

    it("should accept custom currency", async () => {
      await registry.execute("add_product_price", {
        productId: TEST_PRODUCT_ID,
        priceType: "LIST",
        amount: 25.00,
        currencyCode: "EUR",
      }, createContext({ productService: mockProductService }));

      expect(mockProductService.addProductPrice).toHaveBeenCalledWith(
        expect.objectContaining({ currencyCode: "EUR" })
      );
    });

    it("should reject zero amount", async () => {
      const result = await registry.execute("add_product_price", {
        productId: TEST_PRODUCT_ID,
        priceType: "LIST",
        amount: 0,
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should reject negative amount", async () => {
      const result = await registry.execute("add_product_price", {
        productId: TEST_PRODUCT_ID,
        priceType: "LIST",
        amount: -5,
      }, createContext({ productService: mockProductService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });

  describe("security service validation", () => {
    it("should throw when productService is missing", async () => {
      await expect(
        registry.execute("create_product", {
          productType: "GOOD",
          name: "Test Product",
        }, createContext())
      ).rejects.toThrow("ProductService not available");
    });
  });
});
