// Product Domain Service — Core business logic for product operations.
//
// Implements Silverstone Ch. 3: Product / Goods.
// Implements ERP_PLAN.md Phase 1: core-product.

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service.js";
import { Prisma } from "@prisma/client";
import type { TenantScopedClient } from "@besterp/database";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
  UUID_REGEX,
  sanitizeForLogOutput,
  stripHtmlTags,
  parseISODateTimeAsUTC,
  MAX_PARTY_NAME_LENGTH,
  MAX_PARTY_DESCRIPTION_LENGTH,
  MAX_PRODUCT_TYPE_LENGTH,
  MAX_PRICE_TYPE_LENGTH,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
  DEFAULT_SEARCH_LIMIT,
  MAX_TENANT_ID_LENGTH,
  MAX_SKU_LENGTH,
  MAX_FEATURE_NAME_LENGTH,
  MAX_FEATURE_VALUE_LENGTH,
  DEFAULT_CURRENCY_CODE,
  MAX_CURRENCY_CODE_LENGTH,
  computeHasMore,
  handleTransactionError as mapPrismaError,
  TX_TIMEOUT_MS,
} from "@besterp/shared";
import {
  CreateProductInput,
  ProductResult,
  GetProductResult,
  SearchProductsInput,
  SearchProductsResult,
  UpdateProductInput,
  AddProductFeatureInput,
  ProductFeatureResult,
  AddProductPriceInput,
  ProductPriceResult,
} from "./product.types.js";

@Injectable()
export class ProductService {
  private static readonly PRODUCT_INCLUDE = {
    productType: { select: { name: true, description: true } },
    features: { select: { name: true, value: true } },
    prices: { select: { priceType: true, amount: true, currencyCode: true, fromDate: true, thruDate: true } },
    category: { select: { productCategoryId: true, name: true } },
  } satisfies Prisma.ProductInclude;

  private readonly logger = new Logger(ProductService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Create Product ───────────────────────────────────────────

  async createProduct(input: CreateProductInput): Promise<ProductResult> {
    const { trimmedTenantId, trimmedName, trimmedDescription, trimmedSku, trimmedProductType, validatedFeatures } = ProductService.validateCreateProductInput(input);

    // Validate product type exists
    let productTypeRecord;
    try {
      productTypeRecord = await this.prisma.admin.productType.findUnique({ where: { name: trimmedProductType } });
    } catch (err) {
      throw mapPrismaError(err, "create_product", "create_product", "product");
    }
    if (!productTypeRecord) {
      throw new InvalidTypeValueError(
        `PRODUCT_TYPE '${sanitizeForLogOutput(trimmedProductType)}' is not valid. Use 'get_type_table_values' to see available product types.`,
        { suggestedTools: ["get_type_table_values"], context: { field: "productType", invalidValue: sanitizeForLogOutput(trimmedProductType) } }
      );
    }

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    try {
      const product = await db.$transaction(async (tx) => {
        const data: Prisma.ProductCreateInput = {
          productType: { connect: { productTypeId: productTypeRecord.productTypeId } },
          tenantId: trimmedTenantId,
          name: trimmedName,
          description: trimmedDescription,
          sku: trimmedSku,
        };

        if (input.categoryId) {
          data.category = { connect: { productCategoryId: input.categoryId } };
        }

        if (validatedFeatures && validatedFeatures.length > 0) {
          data.features = { createMany: { data: validatedFeatures } };
        }

        return tx.product.create({ data, select: { productId: true, productTypeId: true, tenantId: true, name: true, description: true, sku: true, version: true, createdAt: true, updatedAt: true } });
      }, { timeout: TX_TIMEOUT_MS });

      this.logger.log(`Created product: ${sanitizeForLogOutput(trimmedName)} (${product.productId})`);
      return ProductService.toProductResult(product);
    } catch (err: unknown) {
      throw mapPrismaError(err, "create_product", "create_product", "product");
    }
  }

  /** Validate and trim all scalar input fields for createProduct.
   *  Extracted to keep createProduct's cyclomatic complexity under the lint cap. */
  private static validateCreateProductInput(input: CreateProductInput): { trimmedTenantId: string; trimmedName: string; trimmedDescription: string | null; trimmedSku: string | null; trimmedProductType: string; validatedFeatures: Array<{ name: string; value: string }> | undefined } {
    const tenantId = input.tenantId;
    const productType = input.productType;
    const name = input.name;
    const description = input.description;
    const sku = input.sku;
    const features = input.features;

    const trimmedTenantId = ProductService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "create_product");
    if (typeof name !== "string") {
      throw new InvalidTypeValueError("'name' must be a string.", { suggestedTools: ["create_product"], context: { field: "name", received: typeof name } });
    }
    const trimmedName = ProductService.requireNonEmptyString(name.trim(), "name", MAX_PARTY_NAME_LENGTH, "create_product");
    if (description !== undefined && description !== null && typeof description !== "string") {
      throw new InvalidTypeValueError("'description' must be a string.", { suggestedTools: ["create_product"], context: { field: "description", received: typeof description } });
    }
    const trimmedDescription = description !== undefined && description !== null ? ProductService.requireOptionalString(stripHtmlTags(description.trim()), "description", MAX_PARTY_DESCRIPTION_LENGTH, "create_product") : null;
    if (sku !== undefined && sku !== null && typeof sku !== "string") {
      throw new InvalidTypeValueError("'sku' must be a string.", { suggestedTools: ["create_product"], context: { field: "sku", received: typeof sku } });
    }
    const trimmedSku = sku !== undefined && sku !== null ? ProductService.requireOptionalString(stripHtmlTags(sku.trim()), "sku", MAX_SKU_LENGTH, "create_product") : null;
    const trimmedProductType = ProductService.requireStringField(productType, "productType", MAX_PRODUCT_TYPE_LENGTH, "create_product");

    let validatedFeatures = undefined;
    if (features && features.length > 0) {
      validatedFeatures = features.map((f) => {
        const trimmedName = ProductService.requireNonEmptyString(f.name.trim(), "featureName", MAX_FEATURE_NAME_LENGTH, "create_product");
        const trimmedValue = ProductService.requireNonEmptyString(f.value.trim(), "featureValue", MAX_FEATURE_VALUE_LENGTH, "create_product");
        return { name: trimmedName, value: trimmedValue };
      });
    }

    return { trimmedTenantId, trimmedName, trimmedDescription, trimmedSku, trimmedProductType, validatedFeatures };
  }

  // ─── Get Product ──────────────────────────────────────────────

  async getProduct(tenantId: string, productId: string): Promise<GetProductResult> {
    const trimmedTenantId = ProductService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get_product");
    productId = ProductService.requireUuid(productId, "productId", ["get_product"]);

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    let product;
    try {
      product = await db.product.findUnique({
        where: { productId, tenantId: trimmedTenantId },
        include: ProductService.PRODUCT_INCLUDE,
      });
    } catch (err) {
      throw mapPrismaError(err, "get_product", "get_product", "product");
    }

    if (!product) {
      throw new EntityNotFoundError(
        `Product '${productId}' not found in tenant '${trimmedTenantId}'.`,
        { suggestedTools: ["search_products", "get_product"], context: { productId, tenantId: trimmedTenantId } }
      );
    }

    return ProductService.toGetProductResult(product);
  }

  // ─── Search Products ──────────────────────────────────────────

  async searchProducts(input: SearchProductsInput): Promise<SearchProductsResult> {
    const { tenantId, name, productType, limit = DEFAULT_SEARCH_LIMIT, offset = MIN_SEARCH_OFFSET } = input;

    const trimmedTenantId = ProductService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "search_products");
    ProductService.requireIntegerPageParam(limit, "limit", "search_products");
    ProductService.requireIntegerPageParam(offset, "offset", "search_products");
    const validatedLimit = Math.min(Math.max(limit, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
    const validatedOffset = Math.min(Math.max(offset, MIN_SEARCH_OFFSET), MAX_SEARCH_OFFSET);

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const where: Prisma.ProductWhereInput = { tenantId: trimmedTenantId };

    const trimmedName = ProductService.requireNonEmptyFilter(name, "name", MAX_PARTY_NAME_LENGTH, ["search_products"]);
    if (trimmedName) {
      where.name = { contains: trimmedName, mode: "insensitive" as const };
    }

    const trimmedProductType = ProductService.requireNonEmptyFilter(productType, "productType", MAX_PRODUCT_TYPE_LENGTH, ["search_products"]);
    if (trimmedProductType) {
      where.productType = { name: { equals: trimmedProductType, mode: "insensitive" as const } };
    }

    // Run count first, then findMany with the validated limit. Under READ
    // COMMITTED, concurrent INSERTs between a parallel count+findMany can cause
    // `total` and `items.length` to disagree (worst case: off-by-one in hasMore).
    // Running sequentially avoids this: the count establishes a snapshot of the
    // total, and findMany uses the same WHERE clause with a capped take so even
    // if new rows are inserted between the two queries, we never return more than
    // `limit` items or report hasMore=true when there are no more items.
    // Mirrors PartyService.searchParties (round 176).
    let total: number;
    let items: Awaited<ReturnType<typeof db.product.findMany>>;
    try {
      total = await db.product.count({ where });
      items = await db.product.findMany({
        where,
        include: { productType: { select: { name: true } }, category: { select: { name: true } } },
        take: validatedLimit,
        skip: validatedOffset,
        orderBy: [{ name: "asc" }, { productId: "asc" }],
      });
    } catch (err) {
      throw mapPrismaError(err, "search_products", "search_products", "product");
    }

    return {
      items: items.map((p) => ProductService.toProductResult(p)),
      total,
      limit: validatedLimit,
      offset: validatedOffset,
      hasMore: computeHasMore(validatedOffset, validatedLimit, total),
    };
  }

  // ─── Update Product ───────────────────────────────────────────

  async updateProduct(input: UpdateProductInput): Promise<ProductResult> {
    const { tenantId, productId: rawProductId, ...updates } = input;

    const trimmedTenantId = ProductService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "update_product");
    const productId = ProductService.requireUuid(rawProductId, "productId", ["update_product"]);

    const updateData = ProductService.buildUpdateData(updates, "update_product");
    await ProductService.validateUpdateProductType(updates.productTypeId, updateData, "update_product", this.prisma);

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    if (Object.keys(updateData).length === 0) {
      throw new InvalidTypeValueError("No update fields provided.", { suggestedTools: ["update_product"] });
    }

    try {
      const product = await db.product.update({
        where: { productId, tenantId: trimmedTenantId },
        data: updateData,
        select: { productId: true, productTypeId: true, tenantId: true, name: true, description: true, sku: true, version: true, createdAt: true, updatedAt: true },
      });
      return ProductService.toProductResult(product);
    } catch (err: unknown) {
      throw mapPrismaError(err, "update_product", "update_product", "product");
    }
  }

  /** Build the Prisma updateData object from partial UpdateProductInput.
   *  Extracted from updateProduct to keep its complexity under the lint cap.
   *  Each branch validates and sanitizes one optional field. */
  private static buildUpdateData(updates: Partial<UpdateProductInput>, tool: string): Prisma.ProductUpdateInput {
    const updateData: Prisma.ProductUpdateInput = {};
    ProductService.validateUpdateName(updates.name, updateData, tool);
    ProductService.validateUpdateDescription(updates.description, updateData, tool);
    ProductService.validateUpdateSku(updates.sku, updateData, tool);
    return updateData;
  }

  private static async validateUpdateProductType(
    productTypeId: string | undefined,
    updateData: Prisma.ProductUpdateInput,
    tool: string,
    prisma: PrismaService,
  ): Promise<void> {
    if (productTypeId !== undefined && typeof productTypeId !== "string") {
      throw new InvalidTypeValueError("'productTypeId' must be a string.", { suggestedTools: [tool], context: { field: "productTypeId", received: typeof productTypeId } });
    }
    if (productTypeId !== undefined) {
      const trimmedProductTypeId = productTypeId.trim();
      let pt;
      try {
        pt = await prisma.admin.productType.findUnique({ where: { name: trimmedProductTypeId } });
      } catch (err) {
        throw mapPrismaError(err, "update_product", "update_product", "product");
      }
      if (!pt) {
        throw new InvalidTypeValueError(
          `PRODUCT_TYPE '${sanitizeForLogOutput(trimmedProductTypeId)}' is not valid.`,
          { suggestedTools: ["get_type_table_values"], context: { field: "productTypeId", invalidValue: sanitizeForLogOutput(trimmedProductTypeId) } }
        );
      }
      updateData.productType = { connect: { productTypeId: pt.productTypeId } };
    }
  }

  private static validateUpdateName(name: string | undefined, updateData: Prisma.ProductUpdateInput, tool: string): void {
    if (name !== undefined && typeof name !== "string") {
      throw new InvalidTypeValueError("'name' must be a string.", { suggestedTools: [tool], context: { field: "name", received: typeof name } });
    }
    if (name !== undefined) updateData.name = ProductService.requireNonEmptyString(name.trim(), "name", MAX_PARTY_NAME_LENGTH, tool);
  }

  private static validateUpdateDescription(description: string | null | undefined, updateData: Prisma.ProductUpdateInput, tool: string): void {
    if (description !== undefined && description !== null && typeof description !== "string") {
      throw new InvalidTypeValueError("'description' must be a string.", { suggestedTools: [tool], context: { field: "description", received: typeof description } });
    }
    if (description !== undefined) updateData.description = description === null ? null : ProductService.requireOptionalString(stripHtmlTags(description.trim()), "description", MAX_PARTY_DESCRIPTION_LENGTH, tool);
  }

  private static validateUpdateSku(sku: string | null | undefined, updateData: Prisma.ProductUpdateInput, tool: string): void {
    if (sku !== undefined && sku !== null && typeof sku !== "string") {
      throw new InvalidTypeValueError("'sku' must be a string.", { suggestedTools: [tool], context: { field: "sku", received: typeof sku } });
    }
    if (sku !== undefined) updateData.sku = sku === null ? null : ProductService.requireOptionalString(stripHtmlTags(sku.trim()), "sku", MAX_SKU_LENGTH, tool);
  }

  // ─── Add Product Feature ──────────────────────────────────────

  async addProductFeature(input: AddProductFeatureInput): Promise<ProductFeatureResult> {
    const { tenantId, productId: rawProductId, name, value } = input;

    const trimmedTenantId = ProductService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "add_product_feature");
    const productId = ProductService.requireUuid(rawProductId, "productId", ["add_product_feature"]);
    if (typeof name !== "string") {
      throw new InvalidTypeValueError("'name' must be a string.", { suggestedTools: ["add_product_feature"], context: { field: "name", received: typeof name } });
    }
    const trimmedName = ProductService.requireNonEmptyString(name.trim(), "featureName", MAX_FEATURE_NAME_LENGTH, "add_product_feature");
    if (typeof value !== "string") {
      throw new InvalidTypeValueError("'value' must be a string.", { suggestedTools: ["add_product_feature"], context: { field: "value", received: typeof value } });
    }
    const trimmedValue = ProductService.requireNonEmptyString(value.trim(), "featureValue", MAX_FEATURE_VALUE_LENGTH, "add_product_feature");

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    try {
      const product = await db.product.findUnique({ where: { productId, tenantId: trimmedTenantId } });
      if (!product) {
        throw new EntityNotFoundError(
          `Product '${productId}' not found in tenant '${trimmedTenantId}'.`,
          { suggestedTools: ["search_products", "get_product"], context: { productId, tenantId: trimmedTenantId } }
        );
      }

      const feature = await db.productFeature.create({
        data: { productId, name: trimmedName, value: trimmedValue },
        select: { productFeatureId: true, productId: true, name: true, value: true, createdAt: true },
      });

      return ProductService.toFeatureResult(feature);
    } catch (err: unknown) {
      if (err instanceof EntityNotFoundError) throw err;
      throw mapPrismaError(err, "add_product_feature", "add_product_feature", "product");
    }
  }

  // ─── Add Product Price ────────────────────────────────────────

  async addProductPrice(input: AddProductPriceInput): Promise<ProductPriceResult> {
    const { tenantId, productId: rawProductId, priceType, amount, currencyCode = DEFAULT_CURRENCY_CODE, fromDate, thruDate } = input;

    const trimmedTenantId = ProductService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "add_product_price");
    const productId = ProductService.requireUuid(rawProductId, "productId", ["add_product_price"]);
    const parsedDates = ProductService.parsePriceDates(priceType, amount, currencyCode, fromDate, thruDate, "add_product_price");

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    try {
      const product = await db.product.findUnique({ where: { productId, tenantId: trimmedTenantId } });
      if (!product) {
        throw new EntityNotFoundError(
          `Product '${productId}' not found in tenant '${trimmedTenantId}'.`,
          { suggestedTools: ["search_products", "get_product"], context: { productId, tenantId: trimmedTenantId } }
        );
      }

      const price = await db.productPrice.create({
        data: {
          productId,
          priceType: parsedDates.priceType,
          amount: parsedDates.amount,
          currencyCode: parsedDates.currencyCode,
          fromDate: parsedDates.fromDate,
          thruDate: parsedDates.thruDate,
        },
        select: { productPriceId: true, productId: true, priceType: true, amount: true, currencyCode: true, fromDate: true, thruDate: true, createdAt: true },
      });

      return ProductService.toPriceResult(price);
    } catch (err: unknown) {
      if (err instanceof EntityNotFoundError) throw err;
      throw mapPrismaError(err, "add_product_price", "add_product_price", "product");
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private static requireStringField(value: unknown, field: string, maxLength: number, tool: string): string {
    if (typeof value !== "string") {
      throw new InvalidTypeValueError(`'${field}' must be a string.`, { suggestedTools: [tool], context: { field, received: typeof value } });
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new InvalidTypeValueError(`'${field}' must not be empty.`, { suggestedTools: [tool], context: { field } });
    }
    if (trimmed.length > maxLength) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${maxLength} characters.`, { suggestedTools: [tool], context: { field, length: trimmed.length } });
    }
    return trimmed;
  }

  /** Parse and validate date fields for addProductPrice.
   *  Extracted from addProductPrice to keep its complexity under the lint cap. */
  private static parsePriceDates(
    priceType: string,
    amount: number,
    currencyCode: string,
    fromDate: string | null | undefined,
    thruDate: string | null | undefined,
    tool: string,
  ): { priceType: string; amount: number; currencyCode: string; fromDate: Date; thruDate: Date | null } {
    ProductService.validatePriceAmount(amount, tool);
    ProductService.validatePriceType(priceType, tool);
    ProductService.validatePriceCurrencyCode(currencyCode, tool);
    const parsedFromDate = fromDate ? parseISODateTimeAsUTC(fromDate) : new Date();
    ProductService.validateParsedDate(parsedFromDate, "fromDate", fromDate, tool);
    const parsedThruDate = thruDate ? parseISODateTimeAsUTC(thruDate) : null;
    ProductService.validateParsedDate(parsedThruDate, "thruDate", thruDate, tool);
    return { priceType: priceType.toUpperCase(), amount, currencyCode: currencyCode.toUpperCase(), fromDate: parsedFromDate, thruDate: parsedThruDate };
  }

  private static validatePriceAmount(amount: number, tool: string): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new InvalidTypeValueError("'amount' must be a finite number greater than zero.", { suggestedTools: [tool], context: { field: "amount", received: amount } });
    }
  }

  private static validatePriceType(priceType: string, tool: string): void {
    if (priceType.trim().length === 0) {
      throw new InvalidTypeValueError("'priceType' must not be empty.", { suggestedTools: [tool], context: { field: "priceType" } });
    }
    // Zod schema (product-tools.ts) enforces max 50 chars at the boundary,
    // but direct/internal callers bypass Zod — this is the last line of
    // defense so an oversized priceType cannot reach the DB (round 234).
    if (priceType.trim().length > MAX_PRICE_TYPE_LENGTH) {
      throw new InvalidTypeValueError(`'priceType' exceeds maximum length of ${MAX_PRICE_TYPE_LENGTH} characters.`, { suggestedTools: [tool], context: { field: "priceType", length: priceType.trim().length } });
    }
  }

  private static validatePriceCurrencyCode(currencyCode: string, tool: string): void {
    if (typeof currencyCode !== "string") {
      throw new InvalidTypeValueError("'currencyCode' must be a string.", { suggestedTools: [tool], context: { field: "currencyCode", received: typeof currencyCode } });
    }
    if (currencyCode.length !== MAX_CURRENCY_CODE_LENGTH) {
      throw new InvalidTypeValueError(`'currencyCode' must be ${MAX_CURRENCY_CODE_LENGTH} characters.`, { suggestedTools: [tool], context: { field: "currencyCode", length: currencyCode.length } });
    }
  }

  private static validateParsedDate(date: Date | null, field: string, rawValue: unknown, tool: string): void {
    if (date && isNaN(date.getTime())) {
      throw new InvalidTypeValueError(`'${field}' must be a valid ISO 8601 date.`, { suggestedTools: [tool], context: { field, invalidValue: sanitizeForLogOutput(typeof rawValue === "string" ? rawValue : "") } });
    }
  }

  private static requireNonEmptyString(value: string, field: string, maxLength: number, tool: string): string {
    if (value.length === 0) {
      throw new InvalidTypeValueError(`'${field}' must not be empty.`, { suggestedTools: [tool], context: { field } });
    }
    if (value.length > maxLength) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${maxLength} characters.`, { suggestedTools: [tool], context: { field, length: value.length } });
    }
    return stripHtmlTags(value);
  }

  private static requireOptionalString(value: string, field: string, maxLength: number, tool: string): string | null {
    if (value.length === 0) return null;
    if (value.length > maxLength) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${maxLength} characters.`, { suggestedTools: [tool], context: { field, length: value.length } });
    }
    return stripHtmlTags(value);
  }

  private static requireUuid(value: string, field: string, suggestedTools: string[]): string {
    const trimmed = value.trim();
    if (!UUID_REGEX.test(trimmed)) {
      const safeValue = sanitizeForLogOutput(stripHtmlTags(trimmed));
      throw new InvalidTypeValueError(`'${field}' must be a valid UUID.`, { suggestedTools, context: { field, received: safeValue } });
    }
    return trimmed;
  }

  private static requireNonEmptyFilter(value: string | undefined | null, field: string, maxLength: number, tools: string[]): string | undefined {
    if (value === undefined || value === null) return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new InvalidTypeValueError(`Filter '${field}' cannot be whitespace-only.`, { suggestedTools: tools, context: { field } });
    }
    if (trimmed.length > maxLength) {
      throw new InvalidTypeValueError(`Filter '${field}' exceeds maximum length of ${maxLength} characters.`, { suggestedTools: tools, context: { field, length: trimmed.length } });
    }
    return trimmed;
  }

  private static toProductResult(p: { productId: string; productTypeId: string; tenantId: string; name: string; description: string | null; sku: string | null; version: number; createdAt: Date; updatedAt: Date }): ProductResult {
    return {
      productId: p.productId,
      productTypeId: p.productTypeId,
      tenantId: p.tenantId,
      name: p.name,
      description: p.description,
      sku: p.sku,
      version: p.version,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  private static toGetProductResult(p: {
    productId: string; productTypeId: string; tenantId: string; name: string; description: string | null; sku: string | null; version: number; createdAt: Date; updatedAt: Date;
    productType: { name: string; description: string | null } | null;
    features: Array<{ name: string; value: string }>;
    prices: Array<{ priceType: string; amount: unknown; currencyCode: string; fromDate: Date; thruDate: Date | null }>;
    category: { productCategoryId: string; name: string } | null;
  }): GetProductResult {
    return {
      ...ProductService.toProductResult(p),
      productType: p.productType ?? null,
      features: p.features.map((f) => ({ name: f.name, value: f.value })),
      prices: p.prices.map((pr) => ({
        priceType: pr.priceType,
        amount: ProductService.assertIsNumber(pr.amount, "product price amount"),
        currencyCode: pr.currencyCode,
        fromDate: pr.fromDate.toISOString(),
        thruDate: pr.thruDate?.toISOString() ?? null,
      })),
      category: p.category ?? null,
    };
  }

  private static toFeatureResult(f: { productFeatureId: string; productId: string; name: string; value: string; createdAt: Date }): ProductFeatureResult {
    return {
      productFeatureId: f.productFeatureId,
      productId: f.productId,
      name: f.name,
      value: f.value,
      createdAt: f.createdAt.toISOString(),
    };
  }

  private static toPriceResult(p: { productPriceId: string; productId: string; priceType: string; amount: unknown; currencyCode: string; fromDate: Date; thruDate: Date | null; createdAt: Date }): ProductPriceResult {
    return {
      productPriceId: p.productPriceId,
      productId: p.productId,
      priceType: p.priceType,
      amount: ProductService.assertIsNumber(p.amount, "product price amount"),
      currencyCode: p.currencyCode,
      fromDate: p.fromDate.toISOString(),
      thruDate: p.thruDate?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    };
  }

  /** Validate that a pagination parameter is a finite integer before clamping.
   *  See searchProducts for why the clamp alone is insufficient. The received
   *  value is stringified when non-finite because JSON.stringify(NaN) → null
   *  would erase the diagnostic detail from the serialized DomainError context.
   *  Mirrors PartyService.requireIntegerPageParam (round 176). */
  private static requireIntegerPageParam(value: number, field: string, tool: string): void {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new InvalidTypeValueError(
        `'${field}' must be a finite integer (received ${String(value)}).`,
        { suggestedTools: [tool], context: { field, received: Number.isFinite(value) ? value : String(value) } }
      );
    }
  }

  /**
   * Assert that a value is a number at runtime. Extracted from toGetProductResult
   * and toPriceResult to avoid the IIFE-throw anti-pattern that made those
   * branches unreadable. Mirrors the belt-and-suspenders numeric-type guard
   * already used for product amounts in addProductPrice.
   */
  private static assertIsNumber(value: unknown, label: string): number {
    if (typeof value !== "number") {
      throw new InvalidTypeValueError(
        `Internal data error: ${label} has unexpected type '${typeof value}'.`,
        { context: { field: label, received: typeof value } }
      );
    }
    return value;
  }
}
