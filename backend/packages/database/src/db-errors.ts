/**
 * Postgres error classification. Drizzle wraps driver errors (`DrizzleQueryError.cause`), so look at both levels.
 * Used by the API error handler to turn constraint violations into stable 4xx responses instead of 500s.
 */
export interface PgErrorInfo { code: string; constraint?: string; detail?: string; table?: string }

export function pgError(err: unknown): PgErrorInfo | null {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const o = e as { code?: unknown; constraint?: unknown; detail?: unknown; table?: unknown; cause?: unknown };
    if (typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code)) {
      return {
        code: o.code,
        constraint: typeof o.constraint === 'string' ? o.constraint : undefined,
        detail: typeof o.detail === 'string' ? o.detail : undefined,
        table: typeof o.table === 'string' ? o.table : undefined,
      };
    }
    e = o.cause;
  }
  return null;
}

export const PG = { UNIQUE_VIOLATION: '23505', FK_VIOLATION: '23503', CHECK_VIOLATION: '23514', NOT_NULL_VIOLATION: '23502', RLS_VIOLATION: '42501', SERIALIZATION: '40001', DEADLOCK: '40P01' } as const;

/** Constraint name -> API field, so clients get `{ field: "sku" }` instead of a database constraint name. */
export const CONSTRAINT_FIELDS: Record<string, string> = {
  users_email_uq: 'email',
  vendors_slug_uq: 'slug',
  products_vendor_code_uq: 'productCode',
  product_variants_vendor_sku_uq: 'sku',
  product_variants_vendor_barcode_uq: 'barcode',
  categories_vendor_slug_uq: 'slug',
  attribute_definitions_vendor_code_uq: 'code',
  attribute_values_attr_value_uq: 'value',
  invitations_pending_uq: 'email',
  marketplace_accounts_external_uq: 'externalAccountId',
  warehouses_vendor_code_uq: 'code',
  marketplace_listings_account_variant_uq: 'variantId',
  marketplace_listings_account_sku_uq: 'externalSku',
  category_mappings_uq: 'categoryId',
  attribute_mappings_uq: 'marketplaceAttribute',
  stock_transfers_vendor_number_uq: 'number',
  orders_vendor_marketplace_external_uq: 'externalOrderId',
  orders_account_external_uq: 'externalOrderId',
  imported_products_account_sku_uq: 'externalSku',
};

const NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);

/** The database is unreachable / refusing connections / shutting down (class 08, 28 auth, 57P0x admin shutdown). */
export function isConnectivityError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const o = e as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof o.code === 'string' && (NET_CODES.has(o.code) || /^(08|28|57P0)/.test(o.code))) return true;
    if (Array.isArray(o.errors) && o.errors.some((x) => isConnectivityError(x))) return true;
    e = o.cause;
  }
  return false;
}
