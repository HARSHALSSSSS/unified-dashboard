import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@oms/shared';

/**
 * Shared API contracts (zod). These are the single source for request validation, response
 * serialisation AND the generated OpenAPI document.
 */

// ---- response envelopes ---------------------------------------------------------------------
export const ErrorBodySchema = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string().meta({ example: 'VALIDATION_FAILED', description: 'Stable machine-readable error code' }),
      message: z.string().meta({ example: 'Request validation failed' }),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
    requestId: z.string().meta({ example: '0198b1b0-7f3a-7d1c-9c3e-5a1f6b9a2c11' }),
  })
  .meta({ id: 'ErrorResponse' });

export const successEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({ success: z.literal(true), data, requestId: z.string() });

export const PaginationMetaSchema = z
  .object({
    limit: z.number().int(),
    nextCursor: z.string().nullable().meta({ description: 'Pass as ?cursor= to fetch the next page; null on the last page' }),
    hasMore: z.boolean(),
  })
  .meta({ id: 'PaginationMeta' });

export const paginatedEnvelope = <T extends z.ZodType>(item: T) =>
  z.object({ success: z.literal(true), data: z.array(item), meta: PaginationMetaSchema, requestId: z.string() });

// ---- query conventions ----------------------------------------------------------------------
/** ?limit=25&cursor=...  (keyset pagination: stable under concurrent writes, O(1) deep pages) */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(512).optional(),
});

/** ?q=free text */
export const SearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200).optional() });

/** ?sort=-createdAt,name  (leading '-' = descending). Each resource whitelists its own sortable fields. */
export const sortQuery = <const F extends readonly [string, ...string[]]>(fields: F) =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ? v.split(',') : []).map((s) => ({ field: s.replace(/^-/, ''), direction: s.startsWith('-') ? ('desc' as const) : ('asc' as const) })),
    )
    .refine((arr) => arr.every((s) => (fields as readonly string[]).includes(s.field)), {
      message: `sort fields must be one of: ${fields.join(', ')}`,
    });

/**
 * Filtering convention: flat query params, `filter[field]=value`. Exact match unless suffixed:
 *   filter[status]=active,paused   (IN)        filter[createdAt][gte]=2025-01-01   (range ops: gte, lte, gt, lt)
 * Resources declare an allow-list of filterable fields in their own querystring schema.
 */

// ---- common params --------------------------------------------------------------------------
export const IdParamSchema = z.object({ id: z.uuid() });
export const IdempotencyKeyHeaderSchema = z.object({
  'idempotency-key': z.string().min(8).max(128).optional().meta({ description: 'Required for retriable POST requests that create resources or trigger side effects' }),
});

// ---- health ---------------------------------------------------------------------------------
export const HealthLiveSchema = z.object({ status: z.literal('ok'), uptimeSeconds: z.number() }).meta({ id: 'HealthLive' });
export const HealthReadySchema = z
  .object({
    status: z.enum(['ready', 'degraded']),
    checks: z.record(z.string(), z.object({ status: z.enum(['up', 'down']), latencyMs: z.number(), error: z.string().optional() })),
  })
  .meta({ id: 'HealthReady' });
export const HealthSchema = z.object({ status: z.literal('ok'), service: z.string(), version: z.string(), environment: z.string() }).meta({ id: 'Health' });

// ---- identity (shape returned by /me) -------------------------------------------------------
export const MeSchema = z
  .object({
    userId: z.string(),
    userType: z.enum(['vendor', 'platform']).nullable(),
    vendorId: z.string().nullable(),
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
  })
  .meta({ id: 'Me' });

export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// ---- documentation tags (the Swagger sections) ---------------------------------------------------
export const API_TAGS = [
  { name: 'System', description: 'Health and platform metadata' },
  { name: 'Auth', description: 'Registration, login, token refresh, logout, e-mail verification and password reset' },
  { name: 'Profile', description: 'Current user profile, password and sessions' },
  { name: 'Vendors', description: 'Vendor (business) profile, settings and platform-level vendor administration' },
  { name: 'Users', description: 'Vendor members, roles and membership' },
  { name: 'Invitations', description: 'Inviting staff into a vendor' },
  { name: 'Roles', description: 'Role and permission catalogue (RBAC)' },
  { name: 'Categories', description: 'Vendor category tree' },
  { name: 'Attributes', description: 'Generic attribute definitions, values and category assignments' },
  { name: 'Products', description: 'Products: CRUD, search, bulk operations, marketplace readiness' },
  { name: 'Variants', description: 'Product variants / SKUs' },
  { name: 'Documents', description: 'Product images, documents and listing documents (object storage)' },
  { name: 'Data Jobs', description: 'Bulk import / export jobs' },
  { name: 'Marketplace Accounts', description: 'A vendor\'s seller accounts on marketplaces (credentials are never exposed)' },
  { name: 'Connectors', description: 'Marketplace connector catalogue, capability matrix, authorization, health and credential lifecycle' },
  { name: 'Warehouses', description: 'Fulfilment locations (default / priority / activation)' },
  { name: 'Inventory', description: 'Stock levels, the append-only movement ledger, reservations, adjustments and warehouse transfers' },
  { name: 'Listings', description: 'Master product -> marketplace listing: validate, preview, merchant approval, publish, status tracking' },
  { name: 'Mappings', description: 'Marketplace category taxonomy, category mappings and attribute mappings' },
  { name: 'Catalog Import', description: 'Import products that already exist on a marketplace (normalised) and turn them into master products' },
  { name: 'Channel Inventory', description: 'Per-marketplace sellable quantity: safety buffer, allocation, caps and push history' },
  { name: 'Orders', description: 'Normalised marketplace orders: import, status model, timeline, cancellation, status sync back to the marketplace' },
  { name: 'Sync Jobs', description: 'Asynchronous marketplace synchronisation: job status, progress, logs, retries and dead letters' },
  { name: 'Webhooks', description: 'Inbound marketplace webhooks (signature-verified, idempotent) and webhook secret management' },
  { name: 'Business Rules', description: 'Controlled rule engine: pricing, stock, marketplace, fulfillment and notification rules' },
  { name: 'Fulfillment', description: 'Order routing, fulfillment lifecycle and exceptions' },
  { name: 'Picking', description: 'Pick lists, pick tasks, barcode scanning, partial picks' },
  { name: 'Packing', description: 'Packing tasks, packages, dimensions, weight, barcode verification' },
  { name: 'Shipping', description: 'Shipping providers, shipments, labels, manifests, tracking, NDR and RTO' },
  { name: 'Returns', description: 'Return orders, receiving, inspection, disposition, refunds' },
  { name: 'Pricing', description: 'Marketplace prices, sales, price rules, bulk updates and price history' },
  { name: 'Notifications', description: 'In-app notifications, preferences, e-mail and push-ready devices' },
  { name: 'Reports', description: 'Sales, orders, inventory, product, marketplace, returns and fulfillment reports' },
  { name: 'Audit', description: 'Audit trail' },
] as const;

// ---- shared DTO building blocks --------------------------------------------------------------------
/** ISO-8601 timestamp string (responses are serialised from Date objects by mappers). */
export const IsoDate = z.string().meta({ format: 'date-time', example: '2026-01-31T10:15:30.000Z' });
export const toIso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** Password policy: length only (NIST 800-63B); breach-list checks can be added in the identity service. */
export const PasswordSchema = z.string().min(10, 'must be at least 10 characters').max(128);
export const GstinSchema = z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'invalid GSTIN');
export const HsnSchema = z.string().trim().regex(/^[0-9]{4,8}$/, 'HSN/SAC must be 4-8 digits');
export const SkuSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'SKU may contain letters, digits and . _ - /');
