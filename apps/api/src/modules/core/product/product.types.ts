// Product Types — Input/Output interfaces for the core-product domain.

// ─── Create Product ──────────────────────────────────────────────

export interface CreateProductInput {
  tenantId: string;
  productType: string;
  name: string;
  description?: string | null;
  sku?: string | null;
  categoryIds?: string[];
  features?: Array<{ name: string; value: string }>;
}

export interface ProductResult {
  productId: string;
  productTypeId: string;
  tenantId: string;
  name: string;
  description: string | null;
  sku: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Get Product ─────────────────────────────────────────────────

export interface GetProductResult extends ProductResult {
  productType: { name: string; description: string | null };
  features: Array<{ name: string; value: string }>;
  prices: Array<{ priceType: string; amount: number; currencyCode: string; fromDate: string; thruDate: string | null }>;
  category: { productCategoryId: string; name: string } | null;
}

// ─── Search Products ─────────────────────────────────────────────

export interface SearchProductsInput {
  tenantId: string;
  name?: string | null;
  productType?: string | null;
  limit?: number;
  offset?: number;
}

export interface SearchProductsResult {
  items: ProductResult[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ─── Update Product ──────────────────────────────────────────────

export interface UpdateProductInput {
  tenantId: string;
  productId: string;
  name?: string;
  description?: string | null;
  sku?: string | null;
  productTypeId?: string;
}

// ─── Add Feature ─────────────────────────────────────────────────

export interface AddProductFeatureInput {
  tenantId: string;
  productId: string;
  name: string;
  value: string;
}

export interface ProductFeatureResult {
  productFeatureId: string;
  productId: string;
  name: string;
  value: string;
  createdAt: string;
}

// ─── Add Price ───────────────────────────────────────────────────

export interface AddProductPriceInput {
  tenantId: string;
  productId: string;
  priceType: string;
  amount: number;
  currencyCode?: string;
  fromDate?: string | null;
  thruDate?: string | null;
}

export interface ProductPriceResult {
  productPriceId: string;
  productId: string;
  priceType: string;
  amount: number;
  currencyCode: string;
  fromDate: string;
  thruDate: string | null;
  createdAt: string;
}
