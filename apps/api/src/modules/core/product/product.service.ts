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
  DuplicateEntityError,
  ConcurrencyConflictError,
  UUID_REGEX,
  sanitizeForLogOutput,
  stripHtmlTags,
  MAX_PARTY_NAME_LENGTH,
  MAX_PARTY_DESCRIPTION_LENGTH,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
  DEFAULT_SEARCH_LIMIT,
  MAX_TENANT_ID_LENGTH,
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

const TX_TIMEOUT_MS = 10_000;

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
    const { tenantId, productType, name, description, sku, features } = input;

    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "create", "create_product");
    const trimmedName = this.requireNonEmptyString(name.trim(), "name", MAX_PARTY_NAME_LENGTH);
    const trimmedDescription = description !== undefined && description !== null ? this.requireOptionalString(description.trim(), "description", MAX_PARTY_DESCRIPTION_LENGTH) : null;
    const trimmedSku = sku !== undefined && sku !== null ? this.requireOptionalString(sku.trim(), "sku", 100) : null;

    // Validate product type exists
    const productTypeRecord = await this.prisma.admin.productType.findUnique({ where: { name: productType } });
    if (!productTypeRecord) {
      throw new InvalidTypeValueError(
        `PRODUCT_TYPE '${productType}' is not valid. Use 'get_type_table_values' to see available product types.`,
        { suggestedTools: ["get_type_table_values"], context: { field: "productType", invalidValue: productType } }
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

        if (input.categoryIds && input.categoryIds.length > 0) {
          data.category = { connect: { productCategoryId: input.categoryIds[0] } };
        }

        if (features && features.length > 0) {
          data.features = { createMany: { data: features.map((f) => ({ name: f.name, value: f.value })) } };
        }

        return tx.product.create({ data, select: { productId: true, productTypeId: true, tenantId: true, name: true, description: true, sku: true, version: true, createdAt: true, updatedAt: true } });
      }, { timeout: TX_TIMEOUT_MS });

      this.logger.log(`Created product: ${sanitizeForLogOutput(trimmedName)} (${product.productId})`);
      return this.toProductResult(product);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        throw new DuplicateEntityError(
          `A product with the same SKU '${sanitizeForLogOutput(trimmedSku ?? "")}' already exists in this tenant.`,
          { suggestedTools: ["search_products", "get_product"] }
        );
      }
      if (code === "P2003") {
        throw new InvalidTypeValueError(
          `Referenced entity does not exist.`,
          { suggestedTools: ["get_type_table_values", "search_products"] }
        );
      }
      throw err;
    }
  }

  // ─── Get Product ──────────────────────────────────────────────

  async getProduct(tenantId: string, productId: string): Promise<GetProductResult> {
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get", "get_product");
    productId = this.requireUuid(productId, "productId");

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const product = await db.product.findUnique({
      where: { productId, tenantId: trimmedTenantId },
      include: ProductService.PRODUCT_INCLUDE,
    });

    if (!product) {
      throw new EntityNotFoundError(
        `Product '${productId}' not found in tenant '${trimmedTenantId}'.`,
        { suggestedTools: ["search_products", "get_product"], context: { productId } }
      );
    }

    return this.toGetProductResult(product);
  }

  // ─── Search Products ──────────────────────────────────────────

  async searchProducts(input: SearchProductsInput): Promise<SearchProductsResult> {
    const { tenantId, name, productType, limit = DEFAULT_SEARCH_LIMIT, offset = MIN_SEARCH_OFFSET } = input;

    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "search", "search_products");
    const validatedLimit = Math.min(Math.max(limit, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
    const validatedOffset = Math.min(Math.max(offset, MIN_SEARCH_OFFSET), MAX_SEARCH_OFFSET);

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const where: Prisma.ProductWhereInput = { tenantId: trimmedTenantId };

    const trimmedName = this.requireNonEmptyFilter(name, "name", MAX_PARTY_NAME_LENGTH, ["search_products"]);
    if (trimmedName) {
      where.name = { contains: trimmedName, mode: "insensitive" as const };
    }

    const trimmedProductType = this.requireNonEmptyFilter(productType, "productType", 100, ["search_products"]);
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
      throw ProductService.handleTransactionError(err, "search_products", "search_products", "product");
    }

    return {
      items: items.map((p) => this.toProductResult(p)),
      total,
      limit: validatedLimit,
      offset: validatedOffset,
      hasMore: validatedOffset + validatedLimit < total && validatedOffset + validatedLimit <= MAX_SEARCH_OFFSET,
    };
  }

  // ─── Update Product ───────────────────────────────────────────

  async updateProduct(input: UpdateProductInput): Promise<ProductResult> {
    const { tenantId, productId: rawProductId, name, description, sku, productTypeId } = input;

    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "update", "update_product");
    const productId = this.requireUuid(rawProductId, "productId");

    const updateData: Prisma.ProductUpdateInput = {};
    if (name !== undefined) updateData.name = this.requireNonEmptyString(name.trim(), "name", MAX_PARTY_NAME_LENGTH);
    if (description !== undefined) updateData.description = description === null ? null : this.requireOptionalString(description.trim(), "description", MAX_PARTY_DESCRIPTION_LENGTH);
    if (sku !== undefined) updateData.sku = sku === null ? null : this.requireOptionalString(sku.trim(), "sku", 100);
    if (productTypeId !== undefined) {
      const pt = await this.prisma.admin.productType.findUnique({ where: { name: productTypeId } });
      if (!pt) {
        throw new InvalidTypeValueError(
          `PRODUCT_TYPE '${productTypeId}' is not valid.`,
          { suggestedTools: ["get_type_table_values"] }
        );
      }
      updateData.productType = { connect: { productTypeId: pt.productTypeId } };
    }

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
      return this.toProductResult(product);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "P2025") {
        throw new EntityNotFoundError(
          `Product '${productId}' not found in tenant '${trimmedTenantId}'.`,
          { suggestedTools: ["search_products", "get_product"] }
        );
      }
      if (code === "P2002") {
        throw new DuplicateEntityError(
          `A product with the same SKU already exists in this tenant.`,
          { suggestedTools: ["search_products"] }
        );
      }
      throw err;
    }
  }

  // ─── Add Product Feature ──────────────────────────────────────

  async addProductFeature(input: AddProductFeatureInput): Promise<ProductFeatureResult> {
    const { tenantId, productId: rawProductId, name, value } = input;

    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "add feature", "add_product_feature");
    const productId = this.requireUuid(rawProductId, "productId");
    const trimmedName = this.requireNonEmptyString(name.trim(), "featureName", 100);
    const trimmedValue = this.requireNonEmptyString(value.trim(), "featureValue", 500);

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const product = await db.product.findUnique({ where: { productId, tenantId: trimmedTenantId } });
    if (!product) {
      throw new EntityNotFoundError(
        `Product '${productId}' not found in tenant '${trimmedTenantId}'.`,
        { suggestedTools: ["search_products", "get_product"] }
      );
    }

    const feature = await db.productFeature.create({
      data: { productId, name: trimmedName, value: trimmedValue },
      select: { productFeatureId: true, productId: true, name: true, value: true, createdAt: true },
    });

    return this.toFeatureResult(feature);
  }

  // ─── Add Product Price ────────────────────────────────────────

  async addProductPrice(input: AddProductPriceInput): Promise<ProductPriceResult> {
    const { tenantId, productId: rawProductId, priceType, amount, currencyCode = "USD", fromDate, thruDate } = input;

    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "add price", "add_product_price");
    const productId = this.requireUuid(rawProductId, "productId");

    if (amount <= 0) {
      throw new InvalidTypeValueError("Price amount must be greater than zero.", { suggestedTools: ["add_product_price"] });
    }

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const product = await db.product.findUnique({ where: { productId, tenantId: trimmedTenantId } });
    if (!product) {
      throw new EntityNotFoundError(
        `Product '${productId}' not found in tenant '${trimmedTenantId}'.`,
        { suggestedTools: ["search_products", "get_product"] }
      );
    }

    const parsedFromDate = fromDate ? new Date(fromDate) : new Date();
    if (isNaN(parsedFromDate.getTime())) {
      throw new InvalidTypeValueError("fromDate must be a valid ISO 8601 date.", { suggestedTools: ["add_product_price"] });
    }

    const parsedThruDate = thruDate ? new Date(thruDate) : null;
    if (parsedThruDate && isNaN(parsedThruDate.getTime())) {
      throw new InvalidTypeValueError("thruDate must be a valid ISO 8601 date.", { suggestedTools: ["add_product_price"] });
    }

    const price = await db.productPrice.create({
      data: {
        productId,
        priceType: priceType.toUpperCase(),
        amount,
        currencyCode,
        fromDate: parsedFromDate,
        thruDate: parsedThruDate,
      },
      select: { productPriceId: true, productId: true, priceType: true, amount: true, currencyCode: true, fromDate: true, thruDate: true, createdAt: true },
    });

    return this.toPriceResult(price);
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private static getPrismaErrorCode(err: unknown): string | undefined {
    if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
      return (err as { code: string }).code;
    }
    return undefined;
  }

  private static throwMappedPrismaError(
    code: string,
    err: { code: string; meta?: Record<string, unknown> },
    retryTool: string,
    suggestTool: string,
    entityName: string,
  ): never {
    switch (code) {
      case "P2002": {
        const field = ProductService.resolveConflictField(err);
        throw new DuplicateEntityError(
          `A ${entityName} with the same ${field} already exists in this tenant.`,
          { suggestedTools: [suggestTool], context: { prismaCode: "P2002", conflictingField: field } }
        );
      }
      case "P2003": {
        const constraint = ProductService.resolveConstraintName(err);
        throw new InvalidTypeValueError(
          `Referenced ${entityName} does not exist (constraint: ${constraint}).`,
          { suggestedTools: [suggestTool], context: { prismaCode: "P2003", constraint } }
        );
      }
      case "P2025": {
        throw new EntityNotFoundError(
          `${entityName} not found for this operation.`,
          { suggestedTools: [retryTool, suggestTool], context: { prismaCode: "P2025" } }
        );
      }
      case "P2028":
      case "P2034": {
        throw new ConcurrencyConflictError(
          `Transaction conflict or timeout on ${entityName} — please retry.`,
          { suggestedTools: [retryTool], context: { prismaCode: code } }
        );
      }
      case "P2024": {
        throw new ConcurrencyConflictError(
          `Connection pool timeout on ${entityName} — the service is under heavy load.`,
          { suggestedTools: [retryTool], context: { prismaCode: code } }
        );
      }
      default: {
        throw err;
      }
    }
  }

  private static resolveConflictField(err: { code: string; meta?: Record<string, unknown> }): string {
    const meta = err.meta as Record<string, unknown> | undefined;
    const target = meta?.target as string[] | undefined;
    if (Array.isArray(target) && target.length > 0 && typeof target[0] === "string") return target[0];
    return "unique key";
  }

  private static resolveConstraintName(err: { code: string; meta?: Record<string, unknown> }): string {
    const meta = err.meta as Record<string, unknown> | undefined;
    const constraint = meta?.constraint as string | undefined;
    return constraint ?? "unknown";
  }

  private static handleTransactionError(
    err: unknown,
    retryTool: string,
    suggestTool: string,
    entityName = "record",
  ): never {
    if (err == null || typeof err !== "object") {
      throw new InvalidTypeValueError(
        "Database operation failed with an unexpected error type.",
        { context: { type: err === null ? "null" : typeof err } }
      );
    }
    const code = ProductService.getPrismaErrorCode(err);
    if (!code) throw err;
    if (!/^P\d{4}$/.test(code)) throw err;
    if (/^P1\d{3}$/.test(code)) throw err;
    return ProductService.throwMappedPrismaError(code, err as { code: string; meta?: Record<string, unknown> }, retryTool, suggestTool, entityName);
  }

  private requireStringField(value: unknown, field: string, maxLength: number, _action: string, tool: string): string {
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

  private requireNonEmptyString(value: string, field: string, maxLength: number): string {
    if (value.length === 0) {
      throw new InvalidTypeValueError(`'${field}' must not be empty.`, { context: { field } });
    }
    if (value.length > maxLength) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${maxLength} characters.`, { context: { field, length: value.length } });
    }
    return stripHtmlTags(value);
  }

  private requireOptionalString(value: string, field: string, maxLength: number): string | null {
    if (value.length === 0) return null;
    if (value.length > maxLength) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${maxLength} characters.`, { context: { field, length: value.length } });
    }
    return stripHtmlTags(value);
  }

  private requireUuid(value: string, field: string): string {
    const trimmed = value.trim();
    if (!UUID_REGEX.test(trimmed)) {
      throw new InvalidTypeValueError(`'${field}' must be a valid UUID.`, { context: { field, received: trimmed } });
    }
    return trimmed;
  }

  private requireNonEmptyFilter(value: string | undefined | null, field: string, maxLength: number, tools: string[]): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new InvalidTypeValueError(`Filter '${field}' cannot be whitespace-only.`, { suggestedTools: tools, context: { field } });
    }
    if (trimmed.length > maxLength) {
      throw new InvalidTypeValueError(`Filter '${field}' exceeds maximum length of ${maxLength} characters.`, { suggestedTools: tools, context: { field, length: trimmed.length } });
    }
    return trimmed;
  }

  private toProductResult(p: { productId: string; productTypeId: string; tenantId: string; name: string; description: string | null; sku: string | null; version: number; createdAt: Date; updatedAt: Date }): ProductResult {
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

  private toGetProductResult(p: {
    productId: string; productTypeId: string; tenantId: string; name: string; description: string | null; sku: string | null; version: number; createdAt: Date; updatedAt: Date;
    productType: { name: string; description: string | null } | null;
    features: Array<{ name: string; value: string }>;
    prices: Array<{ priceType: string; amount: unknown; currencyCode: string; fromDate: Date; thruDate: Date | null }>;
    category: { productCategoryId: string; name: string } | null;
  }): GetProductResult {
    return {
      ...this.toProductResult(p),
      productType: p.productType ?? { name: "", description: null },
      features: p.features.map((f) => ({ name: f.name, value: f.value })),
      prices: p.prices.map((pr) => ({
        priceType: pr.priceType,
        amount: typeof pr.amount === "number" ? pr.amount : parseFloat(String(pr.amount)) || 0,
        currencyCode: pr.currencyCode,
        fromDate: pr.fromDate.toISOString(),
        thruDate: pr.thruDate?.toISOString() ?? null,
      })),
      category: p.category ?? null,
    };
  }

  private toFeatureResult(f: { productFeatureId: string; productId: string; name: string; value: string; createdAt: Date }): ProductFeatureResult {
    return {
      productFeatureId: f.productFeatureId,
      productId: f.productId,
      name: f.name,
      value: f.value,
      createdAt: f.createdAt.toISOString(),
    };
  }

  private toPriceResult(p: { productPriceId: string; productId: string; priceType: string; amount: unknown; currencyCode: string; fromDate: Date; thruDate: Date | null; createdAt: Date }): ProductPriceResult {
    return {
      productPriceId: p.productPriceId,
      productId: p.productId,
      priceType: p.priceType,
      amount: typeof p.amount === "number" ? p.amount : parseFloat(String(p.amount)) || 0,
      currencyCode: p.currencyCode,
      fromDate: p.fromDate.toISOString(),
      thruDate: p.thruDate?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    };
  }
}
