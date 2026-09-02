// Product MCP Tools — Tool definitions for the Product domain.
//
// Implements ERP_PLAN.md Phase 1: core-product
// Implements Silverstone Ch. 3: Product / Goods

import { z } from "zod";
import {
  ToolRegistry,
  ToolDefinition,
  ToolContext,
} from "@besterp/mcp-tools";
import {
  InvalidTypeValueError,
  UUID_REGEX,
  stripHtmlTags,
  MAX_PARTY_NAME_LENGTH,
  MAX_PARTY_DESCRIPTION_LENGTH,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
} from "@besterp/shared";
import type {
  CreateProductInput,
  SearchProductsInput,
  AddProductFeatureInput,
  AddProductPriceInput,
  ProductResult,
  GetProductResult,
  SearchProductsResult,
  ProductFeatureResult,
  ProductPriceResult,
} from "../../modules/core/product/product.types.js";

interface ProductServices {
  productService: {
    createProduct(input: CreateProductInput): Promise<ProductResult>;
    getProduct(tenantId: string, productId: string): Promise<GetProductResult>;
    searchProducts(input: SearchProductsInput): Promise<SearchProductsResult>;
    addProductFeature(input: AddProductFeatureInput): Promise<ProductFeatureResult>;
    addProductPrice(input: AddProductPriceInput): Promise<ProductPriceResult>;
  };
}

function getProductService(ctx: ToolContext) {
  const svc = ctx.services.productService;
  if (svc === undefined || svc === null || typeof svc !== "object") {
    throw new InvalidTypeValueError(
      "ProductService not available in ToolContext.services",
      { context: { field: "productService" } }
    );
  }
  const requiredMethods: (keyof ProductServices["productService"])[] = [
    "createProduct", "getProduct", "searchProducts", "addProductFeature", "addProductPrice",
  ];
  for (const method of requiredMethods) {
    if (typeof (svc as ProductServices["productService"])[method] !== "function") {
      throw new InvalidTypeValueError(
        `ProductService in ToolContext.services is missing required method '${method}'`,
        { context: { field: "productService", missingMethod: method } }
      );
    }
  }
  return svc as ProductServices["productService"];
}

// ─── Schema builders ─────────────────────────────────────────────

function sanitizedString(min: number, max: number) {
  return z.string()
    .transform((s) => stripHtmlTags(s.trim()))
    .pipe(z.string().min(min).max(max));
}

function optionalFilteredString(max: number) {
  return z.string()
    .optional()
    .transform((s) => {
      if (s === undefined) return undefined;
      const trimmed = stripHtmlTags(s.trim());
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .pipe(z.string().max(max).optional());
}

function optionalSearchFilterString(max: number) {
  return z.string()
    .optional()
    .transform((s) => (s === undefined ? undefined : stripHtmlTags(s.trim())))
    .pipe(
      z.string()
        .min(1, "Filter cannot be whitespace-only — provide a real filter or omit the field")
        .max(max)
        .optional()
    );
}

function uuidParam(description: string) {
  return z.string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(36).regex(UUID_REGEX, "Must be a valid UUID"))
    .describe(description);
}

// ─── Tool: create_product ────────────────────────────────────────

const createProductSchema = z.strictObject({
  productType: z.string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().min(1).max(100))
    .describe("Product type (e.g., 'GOOD', 'SERVICE', 'RAW_MATERIAL')"),
  name: sanitizedString(1, MAX_PARTY_NAME_LENGTH).describe("Product name (1-500 characters)"),
  description: optionalFilteredString(MAX_PARTY_DESCRIPTION_LENGTH).describe("Optional product description"),
  sku: optionalFilteredString(100).describe("Optional stock-keeping unit (must be unique within tenant)"),
  categoryIds: z.array(z.string().uuid()).optional().describe("Optional category IDs to associate with this product"),
  features: z.array(z.strictObject({
    name: sanitizedString(1, 100).describe("Feature name (e.g., 'color', 'size')"),
    value: sanitizedString(1, 500).describe("Feature value"),
  })).optional().describe("Optional product features"),
});

type CreateProductInput_z = z.infer<typeof createProductSchema>;

const createProduct: ToolDefinition = {
  name: "create_product",
  description: `Creates a new product (good or service) in the ERP system.

Use this to add items to your catalog. After creating a product, you can add
prices with 'add_product_price' and features with 'add_product_feature'.

Available product types: Use 'get_type_table_values' with typeName "PRODUCT_TYPE"
to see valid types (e.g., GOOD, SERVICE, RAW_MATERIAL).

Example: Create a physical good
  create_product({ productType: "GOOD", name: "Widget A", sku: "WID-001" })

Example: Create a service
  create_product({ productType: "SERVICE", name: "Consulting", description: "Hourly consulting" })

For idempotent writes, pass an idempotencyKey along with the tool arguments.`,

  inputSchema: createProductSchema,

  riskLevel: "high",
  entity: "product",
  tags: ["product", "create", "core"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as CreateProductInput_z;
    const svc = getProductService(context);
    const product = await svc.createProduct({
      tenantId: context.tenantId,
      productType: input.productType,
      name: input.name,
      description: input.description ?? null,
      sku: input.sku ?? null,
      categoryIds: input.categoryIds,
      features: input.features,
    });
    return {
      success: true,
      data: product,
      nextActions: [
        "Use 'add_product_price' to set pricing for this product.",
        "Use 'add_product_feature' to add attributes like color, size, weight.",
        "Use 'get_product' to see full product details.",
      ],
    };
  },
};

// ─── Tool: get_product ───────────────────────────────────────────

const getProduct: ToolDefinition = {
  name: "get_product",
  description: `Get a product by ID, including features and prices.

Returns full product details with all features and active prices.`,

  inputSchema: z.strictObject({
    productId: uuidParam("The unique UUID of the product"),
  }),

  riskLevel: "none",
  entity: "product",
  tags: ["product", "read", "core"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as { productId: string };
    const svc = getProductService(context);
    const product = await svc.getProduct(context.tenantId, input.productId);
    return {
      success: true,
      data: product,
      nextActions: [
        "Use 'add_product_price' to add or update pricing.",
        "Use 'add_product_feature' to add product attributes.",
        "Use 'search_products' to find related products.",
      ],
    };
  },
};

// ─── Tool: search_products ───────────────────────────────────────

const searchProductsSchema = z.strictObject({
  name: optionalSearchFilterString(MAX_PARTY_NAME_LENGTH).describe("Filter by name (partial match, case-insensitive)"),
  productType: optionalSearchFilterString(100).describe("Filter by product type (e.g., 'GOOD', 'SERVICE')"),
  limit: z.number().int().min(MIN_SEARCH_LIMIT).max(MAX_SEARCH_LIMIT).optional().default(DEFAULT_SEARCH_LIMIT),
  offset: z.number().int().min(MIN_SEARCH_OFFSET).max(MAX_SEARCH_OFFSET).optional().default(0),
});

type SearchProductsInput_z = z.infer<typeof searchProductsSchema>;

const searchProducts: ToolDefinition = {
  name: "search_products",
  description: `Search for products with optional filters.

Returns a paginated list of products matching the criteria.`,

  inputSchema: searchProductsSchema,

  riskLevel: "none",
  entity: "product",
  tags: ["product", "search", "core"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as SearchProductsInput_z;
    const svc = getProductService(context);
    const result = await svc.searchProducts({
      ...input,
      tenantId: context.tenantId,
    });
    return {
      success: true,
      data: result,
      nextActions: [
        `Found ${result.total} ${result.total === 1 ? "product" : "products"}.`,
        "Use 'get_product' with a specific productId to see full details.",
      ],
    };
  },
};

// ─── Tool: add_product_feature ───────────────────────────────────

const addProductFeatureSchema = z.strictObject({
  productId: uuidParam("The UUID of the product to add the feature to"),
  name: sanitizedString(1, 100).describe("Feature name (e.g., 'color', 'size', 'weight')"),
  value: sanitizedString(1, 500).describe("Feature value"),
});

type AddProductFeatureInput_z = z.infer<typeof addProductFeatureSchema>;

const addProductFeature: ToolDefinition = {
  name: "add_product_feature",
  description: `Add a feature (attribute) to a product.

Features are key-value pairs that describe product characteristics
(e.g., color: "red", size: "Large", weight: "2.5kg").`,

  inputSchema: addProductFeatureSchema,

  riskLevel: "medium",
  entity: "product",
  tags: ["product", "feature", "update"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as AddProductFeatureInput_z;
    const svc = getProductService(context);
    const feature = await svc.addProductFeature({
      tenantId: context.tenantId,
      productId: input.productId,
      name: input.name,
      value: input.value,
    });
    return {
      success: true,
      data: feature,
      nextActions: [
        "Use 'get_product' to see all features for this product.",
        "Add more features or set pricing with 'add_product_price'.",
      ],
    };
  },
};

// ─── Tool: add_product_price ─────────────────────────────────────

const addProductPriceSchema = z.strictObject({
  productId: uuidParam("The UUID of the product to add the price to"),
  priceType: z.string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().min(1).max(50))
    .describe("Price type (e.g., 'LIST', 'WHOLESALE', 'DISCOUNT')"),
  amount: z.number().positive().describe("Price amount (must be > 0)"),
  currencyCode: z.string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().length(3))
    .default("USD")
    .describe("ISO 4217 currency code (default: USD)"),
  fromDate: z.string().optional().describe("Start date (ISO 8601, default: now)"),
  thruDate: z.string().optional().describe("End date (ISO 8601, null = no expiry)"),
});

type AddProductPriceInput_z = z.infer<typeof addProductPriceSchema>;

const addProductPrice: ToolDefinition = {
  name: "add_product_price",
  description: `Add a price to a product.

Products can have multiple prices of different types (LIST, WHOLESALE, DISCOUNT, etc.).
Prices support effective dating via fromDate/thruDate for price changes over time.`,

  inputSchema: addProductPriceSchema,

  riskLevel: "medium",
  entity: "product",
  tags: ["product", "price", "update"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as AddProductPriceInput_z;
    const svc = getProductService(context);
    const price = await svc.addProductPrice({
      tenantId: context.tenantId,
      productId: input.productId,
      priceType: input.priceType,
      amount: input.amount,
      currencyCode: input.currencyCode,
      fromDate: input.fromDate,
      thruDate: input.thruDate,
    });
    return {
      success: true,
      data: price,
      nextActions: [
        "Use 'get_product' to see all prices for this product.",
        "Add more prices or features as needed.",
      ],
    };
  },
};

// ─── Registration ─────────────────────────────────────────────────

export function registerProductTools(registry: ToolRegistry): void {
  registry.register(createProduct);
  registry.register(getProduct);
  registry.register(searchProducts);
  registry.register(addProductFeature);
  registry.register(addProductPrice);
}
