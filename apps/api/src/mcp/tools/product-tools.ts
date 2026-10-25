// Product MCP Tools — Tool definitions for the Product domain.
//
// Implements ERP_PLAN.md Phase 1: core-product
// Implements Silverstone Ch. 3: Product / Goods

import { z } from "zod";
import {
  ToolRegistry,
  ToolDefinition,
  ToolContext,
  sanitizedString,
  optionalFilteredString,
  optionalSearchFilterString,
  optionalIsoDate,
  uuidParam,
} from "@besterp/mcp-tools";
import {
  InvalidTypeValueError,
  MAX_PARTY_NAME_LENGTH,
  MAX_PARTY_DESCRIPTION_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_PRODUCT_TYPE_LENGTH,
  MAX_PRICE_TYPE_LENGTH,
  MAX_SKU_LENGTH,
  MAX_FEATURE_NAME_LENGTH,
  MAX_FEATURE_VALUE_LENGTH,
  MAX_PRODUCT_FEATURES_LENGTH,
  DEFAULT_CURRENCY_CODE,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
  MAX_DATE_STRING_LENGTH,
  stripHtmlTags,
} from "@besterp/shared";
import type {
  CreateProductInput,
  SearchProductsInput,
  UpdateProductInput,
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
    updateProduct(input: UpdateProductInput): Promise<ProductResult>;
    addProductFeature(input: AddProductFeatureInput): Promise<ProductFeatureResult>;
    addProductPrice(input: AddProductPriceInput): Promise<ProductPriceResult>;
  };
}

function getProductService(ctx: ToolContext) {
  const svc = ctx.services.productService;
  if (svc === undefined || svc === null || typeof svc !== "object") {
    throw new InvalidTypeValueError(
      "ProductService not available in ToolContext.services",
      { suggestedTools: ["list_available_tools"], context: { field: "productService" } }
    );
  }
  const requiredMethods: (keyof ProductServices["productService"])[] = [
    "createProduct", "getProduct", "searchProducts", "updateProduct", "addProductFeature", "addProductPrice",
  ];
  for (const method of requiredMethods) {
    if (typeof (svc as ProductServices["productService"])[method] !== "function") {
      throw new InvalidTypeValueError(
        `ProductService in ToolContext.services is missing required method '${method}'`,
        { suggestedTools: ["list_available_tools"], context: { field: "productService", missingMethod: method } }
      );
    }
  }
  return svc as ProductServices["productService"];
}

// ─── Tool: create_product ────────────────────────────────────────

const createProductSchema = z.strictObject({
  productType: z.string()
    .transform((s) => stripHtmlTags(s.trim()).toUpperCase())
    .pipe(z.string().min(1).max(MAX_PRODUCT_TYPE_LENGTH))
    .describe("Product type (e.g., 'GOOD', 'SERVICE', 'RAW_MATERIAL')"),
  name: sanitizedString(1, MAX_PARTY_NAME_LENGTH).describe(`Product name (1-${MAX_PARTY_NAME_LENGTH} characters)`),
  description: optionalFilteredString(MAX_PARTY_DESCRIPTION_LENGTH).describe("Optional product description"),
  sku: optionalFilteredString(MAX_SKU_LENGTH).describe("Optional stock-keeping unit (must be unique within tenant)"),
  categoryId: uuidParam("Optional category ID to associate with this product").optional(),
  features: z.array(z.strictObject({
    name: sanitizedString(1, MAX_FEATURE_NAME_LENGTH).describe("Feature name (e.g., 'color', 'size')"),
    value: sanitizedString(1, MAX_FEATURE_VALUE_LENGTH).describe("Feature value"),
  })).max(MAX_PRODUCT_FEATURES_LENGTH).optional().describe("Optional product features"),
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

For idempotent writes, pass an idempotencyKey (string, max ${MAX_IDEMPOTENCY_KEY_LENGTH} chars) along with the tool arguments. If the same key is used again, the operation will be safely replayed or deduplicated.`,

  inputSchema: createProductSchema,

  riskLevel: "high",
  entity: "product",
  relatedTools: { get: "get_product", search: "search_products" },
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
      categoryId: input.categoryId,
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
  relatedTools: { get: "get_product", search: "search_products" },
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
  productType: optionalSearchFilterString(MAX_PRODUCT_TYPE_LENGTH).describe("Filter by product type (e.g., 'GOOD', 'SERVICE')"),
  limit: z.number().int().min(MIN_SEARCH_LIMIT).max(MAX_SEARCH_LIMIT).optional().default(DEFAULT_SEARCH_LIMIT).describe(`Maximum results to return (max ${MAX_SEARCH_LIMIT})`),
  offset: z.number().int().min(MIN_SEARCH_OFFSET).max(MAX_SEARCH_OFFSET).optional().default(0).describe(`Number of results to skip (min ${MIN_SEARCH_OFFSET})`),
});

type SearchProductsInput_z = z.infer<typeof searchProductsSchema>;

const searchProducts: ToolDefinition = {
  name: "search_products",
  description: `Search for products with optional filters.

Returns a paginated list of products matching the criteria.`,

  inputSchema: searchProductsSchema,

  riskLevel: "none",
  entity: "product",
  relatedTools: { get: "get_product", search: "search_products" },
  tags: ["product", "search", "core"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as SearchProductsInput_z;
    const svc = getProductService(context);
    const result = await svc.searchProducts({
      ...input,
      tenantId: context.tenantId,
    });
    const morePages = result.hasMore
      ? ` Use offset ${result.offset + result.limit} to see more results.`
      : "";
    return {
      success: true,
      data: result,
      nextActions: [
        `Found ${result.total} ${result.total === 1 ? "product" : "products"}.${morePages}`,
        "Use 'get_product' with a specific productId to see full details.",
      ],
    };
  },
};

// ─── Tool: add_product_feature ───────────────────────────────────

const addProductFeatureSchema = z.strictObject({
  productId: uuidParam("The UUID of the product to add the feature to"),
  name: sanitizedString(1, MAX_FEATURE_NAME_LENGTH).describe("Feature name (e.g., 'color', 'size', 'weight')"),
  value: sanitizedString(1, MAX_FEATURE_VALUE_LENGTH).describe("Feature value"),
});

type AddProductFeatureInput_z = z.infer<typeof addProductFeatureSchema>;

const addProductFeature: ToolDefinition = {
  name: "add_product_feature",
   description: `Add a feature (attribute) to a product.

   Features are key-value pairs that describe product characteristics
   (e.g., color: "red", size: "Large", weight: "2.5kg").

   For idempotent writes, pass an idempotencyKey (string, max ${MAX_IDEMPOTENCY_KEY_LENGTH} chars) along with the tool arguments. If the same key is used again, the operation will be safely replayed or deduplicated.`,

  inputSchema: addProductFeatureSchema,

  riskLevel: "medium",
  entity: "product",
  relatedTools: { get: "get_product", search: "search_products" },
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
    .transform((s) => stripHtmlTags(s.trim()).toUpperCase())
    .pipe(z.string().min(1).max(MAX_PRICE_TYPE_LENGTH))
    .describe("Price type (e.g., 'LIST', 'WHOLESALE', 'DISCOUNT')"),
  amount: z.number().positive().describe("Price amount (must be > 0)"),
  currencyCode: z.string()
    .optional()
    .transform((s) => s === undefined ? undefined : stripHtmlTags(s.trim()).toUpperCase())
    // An ISO 4217 code is three ASCII LETTERS. The length check alone
    // accepted "1US" / "US$" / "12A", which were only rejected later by the
    // service layer — so the tool's own description ("ISO 4217 currency
    // code") and its schema disagreed, and the agent got the rejection from
    // a different layer than the one it was validating against.
    .pipe(z.string().regex(/^[A-Z]{3}$/, "currencyCode must be a 3-letter ISO 4217 code (e.g. 'USD', 'EUR')"))
    .default(DEFAULT_CURRENCY_CODE)
    .describe(`ISO 4217 currency code (default: ${DEFAULT_CURRENCY_CODE})`),
  fromDate: optionalIsoDate(MAX_DATE_STRING_LENGTH).describe(`Start date (ISO 8601, max ${MAX_DATE_STRING_LENGTH} chars, default: now)`),
  thruDate: optionalIsoDate(MAX_DATE_STRING_LENGTH).describe(`End date (ISO 8601, null = no expiry, max ${MAX_DATE_STRING_LENGTH} chars)`),
});

type AddProductPriceInput_z = z.infer<typeof addProductPriceSchema>;

const addProductPrice: ToolDefinition = {
  name: "add_product_price",
   description: `Add a price to a product.

   Products can have multiple prices of different types (LIST, WHOLESALE, DISCOUNT, etc.).
   Prices support effective dating via fromDate/thruDate for price changes over time.

   For idempotent writes, pass an idempotencyKey (string, max ${MAX_IDEMPOTENCY_KEY_LENGTH} chars) along with the tool arguments. If the same key is used again, the operation will be safely replayed or deduplicated.`,

  inputSchema: addProductPriceSchema,

  riskLevel: "medium",
  entity: "product",
  relatedTools: { get: "get_product", search: "search_products" },
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

// ─── Tool: update_product ─────────────────────────────────────────

const updateProductSchema = z.strictObject({
  productId: uuidParam("The UUID of the product to update"),
  productType: z.string()
    .transform((s) => stripHtmlTags(s.trim()).toUpperCase())
    .pipe(z.string().min(1).max(MAX_PRODUCT_TYPE_LENGTH))
    .optional()
    .describe("New product type (e.g., 'GOOD', 'SERVICE'); omit to keep the current type"),
  name: sanitizedString(1, MAX_PARTY_NAME_LENGTH).optional().describe("New product name"),
  description: optionalFilteredString(MAX_PARTY_DESCRIPTION_LENGTH).optional().describe("New product description"),
  sku: optionalFilteredString(MAX_SKU_LENGTH).optional().describe("New stock-keeping unit (must be unique within tenant)"),
  expectedVersion: z.number()
    .int()
    .min(1)
    .optional()
    .describe("The 'version' you last read. When supplied, the update is rejected with a conflict if somebody else changed the product in the meantime; omit to force the update."),
});

type UpdateProductInput_z = z.infer<typeof updateProductSchema>;

const updateProduct: ToolDefinition = {
  name: "update_product",
  description: `Update an existing product in the ERP catalog.

Change the name, description, SKU or product type of a product. Only the
fields you provide are changed — omitted fields keep their current value.

Use 'get_product' first to see the current values, and 'search_products' to
find the product if you do not have its productId.

Pass 'expectedVersion' (the version you last read) to make the update
conditional: if somebody else changed the product in the meantime, the
update is rejected with a conflict instead of overwriting their change.

For idempotent writes, pass an idempotencyKey (string, max ${MAX_IDEMPOTENCY_KEY_LENGTH} chars) along with the tool arguments. If the same key is used again, the operation will be safely replayed or deduplicated.`,

  inputSchema: updateProductSchema,

  riskLevel: "high",
  entity: "product",
  relatedTools: { get: "get_product", search: "search_products" },
  tags: ["product", "update", "core"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as UpdateProductInput_z;
    const svc = getProductService(context);
    const product = await svc.updateProduct({
      tenantId: context.tenantId,
      productId: input.productId,
      productType: input.productType,
      name: input.name,
      description: input.description ?? undefined,
      sku: input.sku ?? undefined,
      expectedVersion: input.expectedVersion,
    });
    return {
      success: true,
      data: product,
      nextActions: [
        "Use 'get_product' to review the updated product.",
        "Use 'add_product_price' or 'add_product_feature' to update pricing or attributes.",
      ],
    };
  },
};

// ─── Registration ─────────────────────────────────────────────────

export function registerProductTools(registry: ToolRegistry): void {
  registry.register(createProduct);
  registry.register(getProduct);
  registry.register(searchProducts);
  registry.register(updateProduct);
  registry.register(addProductFeature);
  registry.register(addProductPrice);
}
