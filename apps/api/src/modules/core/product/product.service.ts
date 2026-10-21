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
  isValidISODate,
  MAX_DATE_STRING_LENGTH,
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
  MAX_PRODUCT_FEATURES_LENGTH,
  DEFAULT_CURRENCY_CODE,
  MAX_CURRENCY_CODE_LENGTH,
  computeHasMore,
  handleTransactionError as mapPrismaError,
  decimalToNumber,
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

    // Validate product type exists. The lookup is case-INSENSITIVE so
    // "good", "Good" and "GOOD" all resolve to the same type-table row —
    // `searchProducts` already matched the type case-insensitively, so an
    // exact-match lookup here made the search result unusable for the
    // follow-up write.
    let productTypeRecord;
    try {
      productTypeRecord = await this.prisma.admin.productType.findFirst({
        where: { name: { equals: trimmedProductType, mode: "insensitive" } },
      });
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

    // Validate the category id shape BEFORE opening the transaction — a
    // malformed UUID never needs a round trip.
    const categoryId = input.categoryId
      ? ProductService.requireUuid(input.categoryId, "categoryId", ["create_product"])
      : undefined;

    try {
      const product = await db.$transaction(async (tx) => {
        const data: Prisma.ProductCreateInput = {
          productType: { connect: { productTypeId: productTypeRecord.productTypeId } },
          tenantId: trimmedTenantId,
          name: trimmedName,
          description: trimmedDescription,
          sku: trimmedSku,
        };

        if (categoryId) {
          // The category is a tenant-scoped row, and Postgres runs foreign-key
          // checks with the table owner's rights — which BYPASS RLS. Without an
          // explicit, tenant-scoped lookup, a caller could link a product to
          // another tenant's category and then read that category's name back
          // through getProduct. Verify ownership inside the transaction.
          const category = await tx.productCategory.findFirst({
            where: { productCategoryId: categoryId, tenantId: trimmedTenantId },
            select: { productCategoryId: true },
          });
          if (!category) {
            throw new EntityNotFoundError(
              `Product category '${categoryId}' not found in tenant '${trimmedTenantId}'.`,
              { suggestedTools: ["create_product"], context: { categoryId, tenantId: trimmedTenantId } }
            );
          }
          data.category = { connect: { productCategoryId: categoryId } };
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
    const rawProductType = ProductService.requireStringField(productType, "productType", MAX_PRODUCT_TYPE_LENGTH, "create_product");
    // Normalise to upper case HERE (the service is the single source of
    // truth): the MCP tool uppercased the value before calling, but a REST or
    // internal caller did not — so the same type table entry was reachable
    // through one path and not the other. The lookup is case-insensitive
    // (see below) so both spellings resolve to the same row.
    const trimmedProductType = stripHtmlTags(rawProductType).toUpperCase();
    if (trimmedProductType.length === 0) {
      throw new InvalidTypeValueError("'productType' must contain visible characters after HTML sanitization.", { suggestedTools: ["create_product"], context: { field: "productType" } });
    }

    const validatedFeatures = ProductService.validateProductFeatures(features);
    return { trimmedTenantId, trimmedName, trimmedDescription, trimmedSku, trimmedProductType, validatedFeatures };
  }

  /**
   * Validate and normalise the optional `features` array of create_product.
   *
   * The array LENGTH is bounded here as well as in the Zod schema: without a
   * service-level bound a direct/internal caller could create an unbounded
   * number of `product_feature` rows (and an unbounded audit-log payload).
   * The sibling agent arrays are capped at BOTH layers.
   */
  private static validateProductFeatures(features: CreateProductInput["features"]): Array<{ name: string; value: string }> | undefined {
    if (!features || features.length === 0) return undefined;
    if (features.length > MAX_PRODUCT_FEATURES_LENGTH) {
      throw new InvalidTypeValueError(
        `'features' must contain at most ${MAX_PRODUCT_FEATURES_LENGTH} entries.`,
        { suggestedTools: ["create_product"], context: { field: "features", length: features.length } }
      );
    }
    return features.map((f) => {
      // Type-check before .trim(): a direct/internal caller bypassing the
      // DTO/Zod bounds could pass a non-string feature, and `f.name.trim`
      // throws a raw TypeError that surfaces as a 500 INTERNAL_ERROR instead
      // of the documented InvalidTypeValueError (the same class the party
      // service fixed in round 151).
      if (!f || typeof f !== "object") {
        throw new InvalidTypeValueError("'features' must be an array of { name, value } objects.", { suggestedTools: ["create_product"], context: { field: "features", received: typeof f } });
      }
      if (typeof f.name !== "string") {
        throw new InvalidTypeValueError("'featureName' must be a string.", { suggestedTools: ["create_product"], context: { field: "featureName", received: typeof f.name } });
      }
      if (typeof f.value !== "string") {
        throw new InvalidTypeValueError("'featureValue' must be a string.", { suggestedTools: ["create_product"], context: { field: "featureValue", received: typeof f.value } });
      }
      const trimmedName = ProductService.requireNonEmptyString(f.name.trim(), "featureName", MAX_FEATURE_NAME_LENGTH, "create_product");
      const trimmedValue = ProductService.requireNonEmptyString(f.value.trim(), "featureValue", MAX_FEATURE_VALUE_LENGTH, "create_product");
      return { name: trimmedName, value: trimmedValue };
    });
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
    await ProductService.validateUpdateProductType(updates.productType, updateData, "update_product", this.prisma);

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
    productType: string | undefined,
    updateData: Prisma.ProductUpdateInput,
    tool: string,
    prisma: PrismaService,
  ): Promise<void> {
    if (productType !== undefined && typeof productType !== "string") {
      throw new InvalidTypeValueError("'productType' must be a string.", { suggestedTools: [tool], context: { field: "productType", received: typeof productType } });
    }
    if (productType !== undefined) {
      // Normalise to upper case (same rule as createProduct) and look the type
      // up case-insensitively so "good" resolves to "GOOD".
      const trimmedProductType = stripHtmlTags(productType.trim()).toUpperCase();
      if (trimmedProductType.length === 0) {
        throw new InvalidTypeValueError("'productType' must contain visible characters after HTML sanitization.", { suggestedTools: [tool], context: { field: "productType" } });
      }
      if (trimmedProductType.length > MAX_PRODUCT_TYPE_LENGTH) {
        throw new InvalidTypeValueError(`'productType' exceeds maximum length of ${MAX_PRODUCT_TYPE_LENGTH} characters.`, { suggestedTools: [tool], context: { field: "productType", length: trimmedProductType.length } });
      }
      let pt;
      try {
        pt = await prisma.admin.productType.findFirst({
          where: { name: { equals: trimmedProductType, mode: "insensitive" } },
        });
      } catch (err) {
        throw mapPrismaError(err, tool, tool, "product");
      }
      if (!pt) {
        throw new InvalidTypeValueError(
          `PRODUCT_TYPE '${sanitizeForLogOutput(trimmedProductType)}' is not valid. Use 'get_type_table_values' to see available product types.`,
          { suggestedTools: ["get_type_table_values"], context: { field: "productType", invalidValue: sanitizeForLogOutput(trimmedProductType) } }
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
    const { tenantId, productId: rawProductId, priceType, amount, currencyCode, fromDate, thruDate } = input;

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
    priceType: unknown,
    amount: number,
    currencyCode: unknown,
    fromDate: string | null | undefined,
    thruDate: string | null | undefined,
    tool: string,
  ): { priceType: string; amount: number; currencyCode: string; fromDate: Date; thruDate: Date | null } {
    // Type-check before .trim(): a direct/internal caller bypassing the Zod
    // boundary could pass a non-string, and `priceType.trim` throws a raw
    // TypeError that surfaces as an opaque 500 INTERNAL_ERROR instead of the
    // documented InvalidTypeValueError.
    if (typeof priceType !== "string") {
      throw new InvalidTypeValueError("'priceType' must be a string.", { suggestedTools: [tool], context: { field: "priceType", received: typeof priceType } });
    }
    if (currencyCode !== undefined && currencyCode !== null && typeof currencyCode !== "string") {
      throw new InvalidTypeValueError("'currencyCode' must be a string.", { suggestedTools: [tool], context: { field: "currencyCode", received: typeof currencyCode } });
    }
    const trimmedPriceType = stripHtmlTags(priceType.trim());
    // `?? DEFAULT_CURRENCY_CODE` (not `||`) so an explicit empty string is
    // still reported as invalid rather than silently defaulted — the
    // `= DEFAULT_CURRENCY_CODE` destructuring default only fires for
    // `undefined`, and a `null` value would have crashed on `.trim()`.
    const trimmedCurrencyCode = stripHtmlTags((currencyCode ?? DEFAULT_CURRENCY_CODE).trim()).toUpperCase();
    ProductService.validatePriceAmount(amount, tool);
    ProductService.validatePriceType(trimmedPriceType, tool);
    ProductService.validatePriceCurrencyCode(trimmedCurrencyCode, tool);
    const parsedFromDate = ProductService.parseOptionalDate(fromDate, "fromDate", tool) ?? new Date();
    const parsedThruDate = ProductService.parseOptionalDate(thruDate, "thruDate", tool);
    // A price window that expires BEFORE it starts is nonsense and was
    // silently accepted: the row was stored with thruDate < fromDate, so no
    // point in time was covered by the price.
    if (parsedThruDate !== null && parsedThruDate.getTime() <= parsedFromDate.getTime()) {
      throw new InvalidTypeValueError(
        "'thruDate' must be later than 'fromDate'.",
        { suggestedTools: [tool], context: { field: "thruDate" } }
      );
    }
    return { priceType: trimmedPriceType.toUpperCase(), amount, currencyCode: trimmedCurrencyCode, fromDate: parsedFromDate, thruDate: parsedThruDate };
  }

  /**
   * Parse an optional user-supplied date string.
   *
   * The value is validated with `isValidISODate` BEFORE it is parsed: the
   * shared parse helper only converts a string to a Date, so without this
   * check `"2024-06-31"` silently rolled over to July 1 and
   * `"June 15, 2024"` was parsed as LOCAL midnight — shifting the stored
   * instant by the host's UTC offset. An unparseable string also raised a
   * plain `Error`, which the MCP error handler reported as an opaque
   * INTERNAL_ERROR instead of the structured INVALID_TYPE_VALUE every other
   * invalid input produces.
   *
   * An absent/blank value returns null ("not provided"), matching the
   * boundary layers (the REST DTO transform and the MCP `optionalIsoDate`
   * schema both normalise a blank value to "not provided").
   */
  private static parseOptionalDate(value: string | null | undefined, field: string, tool: string): Date | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new InvalidTypeValueError(`'${field}' must be an ISO 8601 date string.`, { suggestedTools: [tool], context: { field, received: typeof value } });
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > MAX_DATE_STRING_LENGTH) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${MAX_DATE_STRING_LENGTH} characters.`, { suggestedTools: [tool], context: { field, length: trimmed.length } });
    }
    if (!isValidISODate(trimmed)) {
      throw new InvalidTypeValueError(
        `'${field}' is not a valid ISO 8601 date. Received: ${sanitizeForLogOutput(trimmed)}.`,
        { suggestedTools: [tool], context: { field, invalidValue: sanitizeForLogOutput(trimmed) } }
      );
    }
    return parseISODateTimeAsUTC(trimmed);
  }

  private static validatePriceAmount(amount: number, tool: string): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new InvalidTypeValueError("'amount' must be a finite number greater than zero.", { suggestedTools: [tool], context: { field: "amount", received: amount } });
    }
  }

  private static validatePriceType(priceType: string, tool: string): void {
    if (priceType.length === 0) {
      throw new InvalidTypeValueError("'priceType' must not be empty.", { suggestedTools: [tool], context: { field: "priceType" } });
    }
    if (priceType.length > MAX_PRICE_TYPE_LENGTH) {
      throw new InvalidTypeValueError(`'priceType' exceeds maximum length of ${MAX_PRICE_TYPE_LENGTH} characters.`, { suggestedTools: [tool], context: { field: "priceType", length: priceType.length } });
    }
  }

  private static validatePriceCurrencyCode(currencyCode: string, tool: string): void {
    if (typeof currencyCode !== "string") {
      throw new InvalidTypeValueError("'currencyCode' must be a string.", { suggestedTools: [tool], context: { field: "currencyCode", received: typeof currencyCode } });
    }
    if (currencyCode.length === 0) {
      throw new InvalidTypeValueError("'currencyCode' must not be empty.", { suggestedTools: [tool], context: { field: "currencyCode" } });
    }
    if (currencyCode.length !== MAX_CURRENCY_CODE_LENGTH) {
      throw new InvalidTypeValueError(`'currencyCode' must be ${MAX_CURRENCY_CODE_LENGTH} characters.`, { suggestedTools: [tool], context: { field: "currencyCode", length: currencyCode.length } });
    }
    // An ISO 4217 code is three ASCII LETTERS. The length check alone
    // accepted "1US" / "US$" / "12A", which were then stored as a currency
    // code and returned to the agent as such.
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      throw new InvalidTypeValueError(
        "'currencyCode' must be a 3-letter ISO 4217 code (e.g. 'USD', 'EUR').",
        { suggestedTools: [tool], context: { field: "currencyCode", invalidValue: sanitizeForLogOutput(currencyCode) } }
      );
    }
  }

  private static requireNonEmptyString(value: string, field: string, maxLength: number, tool: string): string {
    const stripped = stripHtmlTags(value);
    if (stripped.length === 0) {
      // Preserve the "must not be empty" message for genuinely empty input
      // (no HTML) so existing callers/tests keep their contract.
      if (value.trim().length === 0) {
        throw new InvalidTypeValueError(`'${field}' must not be empty.`, { suggestedTools: [tool], context: { field } });
      }
      throw new InvalidTypeValueError(`'${field}' must contain visible characters after HTML sanitization.`, { suggestedTools: [tool], context: { field } });
    }
    if (stripped.length > maxLength) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${maxLength} characters.`, { suggestedTools: [tool], context: { field, length: stripped.length } });
    }
    return stripped;
  }

  private static requireOptionalString(value: string, field: string, maxLength: number, tool: string): string | null {
    if (value.length === 0) return null;
    if (value.length > maxLength) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${maxLength} characters.`, { suggestedTools: [tool], context: { field, length: value.length } });
    }
    const stripped = stripHtmlTags(value);
    return stripped.length === 0 ? null : stripped;
  }

  private static requireUuid(value: string, field: string, suggestedTools: string[]): string {
    // Type-check before .trim(): a direct/internal caller bypassing the
    // DTO/Zod bounds could pass a non-string id, and `value.trim` throws a
    // raw TypeError that surfaces as a 500 INTERNAL_ERROR instead of the
    // documented InvalidTypeValueError. Mirrors SecurityService.requireUuid.
    if (typeof value !== "string") {
      throw new InvalidTypeValueError(`'${field}' must be a valid UUID.`, { suggestedTools, context: { field, received: typeof value } });
    }
    const trimmed = stripHtmlTags(value.trim());
    if (!UUID_REGEX.test(trimmed)) {
      const safeValue = sanitizeForLogOutput(trimmed);
      throw new InvalidTypeValueError(`'${field}' must be a valid UUID.`, { suggestedTools, context: { field, received: safeValue } });
    }
    return trimmed;
  }

  private static requireNonEmptyFilter(value: string | undefined | null, field: string, maxLength: number, tools: string[]): string | undefined {
    if (value === undefined || value === null) return undefined;
    const trimmed = stripHtmlTags(value.trim());
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
        amount: ProductService.toPriceAmount(pr.amount),
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
      amount: ProductService.toPriceAmount(p.amount),
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
   * Convert a stored `product_price.amount` into a plain number.
   *
   * The column is `Decimal @db.Decimal(19, 4)`, which Prisma returns as a
   * `Prisma.Decimal` OBJECT — never a JS `number`. The previous
   * implementation asserted `typeof value === "number"`, so the branch was
   * never taken for a real database row:
   *   - `get_product` threw `INVALID_TYPE_VALUE: Internal data error:
   *     product price amount has unexpected type 'object'` for EVERY product
   *     that had at least one price;
   *   - `add_product_price` wrote the row and THEN threw, so the agent was told
   *     the write failed although it had been persisted — and a retry under
   *     the same idempotency key created a DUPLICATE price row.
   *
   * The unit tests missed it because the mocks used plain numbers.
   * `decimalToNumber` (shared with the agent transaction-amount mapper) is the
   * single source of truth for this conversion.
   */
  private static toPriceAmount(value: unknown): number {
    const amount = decimalToNumber(value);
    if (amount === null) {
      throw new InvalidTypeValueError(
        "Internal data error: product price amount could not be read as a number.",
        { context: { field: "product price amount" } }
      );
    }
    return amount;
  }
}
