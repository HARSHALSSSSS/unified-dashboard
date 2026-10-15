import { AppError, Errors } from '@oms/shared';
import type { InternalListingStatus, InternalOrderStatus } from './statuses';

export * from './connector-error';
export * from './statuses';
export * from './money';
export * from './http';
export * from './simulation';

/**
 * Marketplace connector contract.
 *
 * Marketplaces differ wildly (auth model, push vs poll, rate limits, catalogue rules), so the core system NEVER
 * assumes a feature exists: it asks the connector's declared `capabilities` first and degrades or skips.
 * A connector implements only what its marketplace supports.
 *
 * Connectors are pure adapters: no database access, no business rules. They receive a short-lived
 * `ConnectorContext` (decrypted credentials injected by the host at call time) and return NORMALISED
 * data. All marketplace-specific shapes (DTOs, status vocabularies, field names) stay inside the connector package.
 */

/** `mock` is the built-in sandbox adapter used for development/testing without marketplace approval. */
export const MARKETPLACES = ['amazon_in', 'flipkart', 'myntra', 'snapdeal', 'mock'] as const;
export type MarketplaceCode = (typeof MARKETPLACES)[number];

export type ImplementationStatus = 'planned' | 'beta' | 'ga';
export type AuthType = 'oauth2_lwa' | 'oauth2' | 'api_key' | 'basic' | 'custom';

export interface ConnectorCapabilities {
  auth: { type: AuthType; refreshable: boolean; /** supports a redirect-based seller authorization flow */ redirectFlow?: boolean };
  account: { fetchProfile: boolean };
  catalog: { import: boolean };
  listings: {
    create: boolean; update: boolean; deactivate: boolean; fetch: boolean; requiresCategoryMapping: boolean;
    /** marketplace category tree / product types can be searched through the API */
    categorySearch: boolean;
    /** the status (pending/active/rejected...) of a submitted listing can be looked up */
    statusLookup: boolean;
  };
  inventory: { push: boolean; pull: boolean; batch: boolean };
  pricing: { push: boolean; pull: boolean };
  orders: { fetch: boolean; webhook: boolean; acknowledge: boolean; updateStatus: boolean; cancel: boolean; maxLookbackDays?: number };
  returns: { fetch: boolean; webhook: boolean };
  shipping: { createShipment: boolean; generateLabel: boolean; marketplaceManagedLogistics: boolean; manifest: boolean };
  /** documented platform limits used by the host's rate limiter / batcher */
  limits: { requestsPerSecond: number; burst: number; maxBatchSize: number };
}

/** Every capability switched off; connectors spread this and enable what their marketplace supports. */
export const NO_CAPABILITIES: Omit<ConnectorCapabilities, 'auth'> = {
  account: { fetchProfile: false },
  catalog: { import: false },
  listings: { create: false, update: false, deactivate: false, fetch: false, requiresCategoryMapping: false, categorySearch: false, statusLookup: false },
  inventory: { push: false, pull: false, batch: false },
  pricing: { push: false, pull: false },
  orders: { fetch: false, webhook: false, acknowledge: false, updateStatus: false, cancel: false },
  returns: { fetch: false, webhook: false },
  shipping: { createShipment: false, generateLabel: false, marketplaceManagedLogistics: false, manifest: false },
  limits: { requestsPerSecond: 1, burst: 1, maxBatchSize: 1 },
};

/** Dotted capability path, e.g. "orders.fetch", "inventory.push". */
export type CapabilityPath =
  | 'account.fetchProfile' | 'catalog.import'
  | 'listings.create' | 'listings.update' | 'listings.deactivate' | 'listings.fetch' | 'listings.categorySearch' | 'listings.statusLookup'
  | 'inventory.push' | 'inventory.pull' | 'pricing.push' | 'pricing.pull'
  | 'orders.fetch' | 'orders.webhook' | 'orders.acknowledge' | 'orders.updateStatus' | 'orders.cancel'
  | 'returns.fetch' | 'returns.webhook'
  | 'shipping.createShipment' | 'shipping.generateLabel';

export function hasCapability(c: Pick<MarketplaceConnector, 'capabilities'>, path: CapabilityPath): boolean {
  const [group, key] = path.split('.') as [keyof ConnectorCapabilities, string];
  return Boolean((c.capabilities[group] as Record<string, unknown> | undefined)?.[key]);
}

/** All enabled capabilities as flat strings (used by the API capability matrix). */
export function enabledCapabilities(c: Pick<MarketplaceConnector, 'capabilities'>): string[] {
  const out: string[] = [];
  for (const [group, caps] of Object.entries(c.capabilities)) {
    if (group === 'limits' || group === 'auth') continue;
    for (const [k, v] of Object.entries(caps as Record<string, unknown>)) if (v === true) out.push(`${group}.${k}`);
  }
  return out;
}

export class CapabilityUnsupportedError extends AppError {
  constructor(marketplace: string, capability: string) {
    super('CAPABILITY_UNSUPPORTED', `${marketplace} does not support ${capability}`, { details: { marketplace, capability } });
  }
}

export function requireCapability(c: Pick<MarketplaceConnector, 'capabilities' | 'code'>, path: CapabilityPath): void {
  if (!hasCapability(c, path)) throw new CapabilityUnsupportedError(c.code, path);
}

// ---- credentials / context -------------------------------------------------------------------
export interface ConnectorCredentials {
  /** opaque to core; shape defined by the connector's own validation */
  [key: string]: unknown;
}

export interface CredentialSet {
  credentials: ConnectorCredentials;
  /** when the ACCESS token expires (drives proactive refresh) */
  expiresAt?: Date;
  scopes?: string[];
}

export interface ConnectorContext {
  vendorId: string;
  marketplaceAccountId: string;
  externalAccountId: string | null;
  mode: 'live' | 'sandbox';
  credentials: ConnectorCredentials;
  /** the account's (non-secret) configuration, e.g. { sandbox: { target: 'simulator' }, marketplaceId: 'A21TJRUUN4KGV' } */
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  requestId?: string;
}

/** Whether (and where) a connector may talk to the real marketplace. `live: false` is enforced by the host. */
export interface ConnectorReadiness {
  /** can run against its in-process simulator and/or the marketplace's official sandbox */
  sandbox: boolean;
  /** verified against the real marketplace with real credentials. NEVER set without that verification. */
  live: boolean;
  notes: string;
}

/** How core obtains data from marketplaces that cannot push it (or as a safety net next to webhooks). */
export interface PollingStrategy {
  orders?: { intervalSeconds: number; lookbackMinutes: number; overlapMinutes: number };
  listingStatus?: { intervalSeconds: number };
}

// ---- normalised models -----------------------------------------------------------------------
export interface Paged<T> { items: T[]; nextCursor: string | null }

export interface RemoteAccount { externalAccountId: string; displayName: string; region?: string; status?: string; scopes?: string[] }

/** Marketplace product -> (connector mapper) -> NormalizedProduct -> (core) -> master product. */
export interface NormalizedProduct {
  externalListingId: string;
  externalSku: string;
  title: string;
  description?: string;
  brand?: string;
  barcode?: string;
  category?: { id: string; name?: string };
  priceMinor?: number;
  mrpMinor?: number;
  currency?: string;
  quantity?: number;
  imageUrls?: string[];
  attributes?: Record<string, unknown>;
  /** normalised listing state on the marketplace */
  status?: 'active' | 'pending' | 'rejected' | 'correction_required' | 'inactive';
  marketplaceStatus?: string;
  raw?: unknown;
}
/** @deprecated name kept for Stage 2 call sites */
export type RemoteProduct = NormalizedProduct;

export type CoreListingField = 'title' | 'description' | 'brand' | 'barcode' | 'sku' | 'price' | 'mrp' | 'quantity' | 'images' | 'hsn_code' | 'country_of_origin' | 'weight_grams' | 'manufacturer';

/** What a marketplace category demands for a listing. */
export interface ListingRequirement {
  /** marketplace attribute name exactly as the marketplace calls it */
  name: string;
  label?: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'enum';
  allowedValues?: string[];
  maxLength?: number;
  description?: string;
  /** suggestion: this attribute is normally fed from this core field (used to auto-propose mappings) */
  coreField?: CoreListingField;
}

export interface MarketplaceCategory { id: string; name: string; path?: string; parentId?: string | null; leaf: boolean }

export interface ListingInput {
  externalSku: string;
  title: string;
  description?: string;
  brand?: string;
  barcode?: string;
  priceMinor: number;
  mrpMinor?: number;
  currency: string;
  quantity?: number;
  /** marketplace attribute name -> value, already resolved from the vendor's mappings */
  attributes?: Record<string, string | number | boolean>;
  marketplaceCategoryId?: string;
  imageUrls?: string[];
}

export interface ListingIssue { code: string; message: string; attribute?: string; severity: 'error' | 'warning' }
export type ListingReportStatus = 'active' | 'pending' | 'rejected' | 'correction_required' | 'inactive';

export interface ListingResult {
  externalListingId: string;
  status: ListingReportStatus;
  /** the marketplace's own status text, kept for debugging */
  marketplaceStatus: string;
  issues: ListingIssue[];
}

export interface ListingStatusReport extends ListingResult { externalSku: string }

/** What WOULD be sent to the marketplace (no network). */
export interface ListingPreview { payload: unknown; warnings: string[]; endpoint: string }

export interface NormalizedOrderItem {
  externalItemId: string;
  externalListingId?: string;
  sku: string;
  title: string;
  quantity: number;
  unitPriceMinor: number;
  taxMinor: number;
  discountMinor: number;
}

export interface NormalizedOrder {
  externalOrderId: string;
  /** internal status, mapped by the connector */
  status: InternalOrderStatus;
  /** the marketplace's own status text, kept for debugging and support */
  marketplaceStatus: string;
  placedAt: Date;
  currency: string;
  subtotalMinor?: number;
  taxMinor?: number;
  shippingMinor?: number;
  discountMinor?: number;
  totalMinor: number;
  buyer?: { name?: string; email?: string; phone?: string };
  shippingAddress?: Record<string, unknown>;
  payment?: { method: 'prepaid' | 'cod' | 'unknown'; status?: string; codAmountMinor?: number };
  items: NormalizedOrderItem[];
  raw: unknown;
}

export interface NormalizedReturn { externalReturnId: string; externalOrderId: string; status: string; reason?: string; requestedAt: Date; raw?: unknown }
export interface InventoryUpdate { externalSku: string; quantity: number; externalListingId?: string }
export interface PriceUpdate { externalSku: string; priceMinor: number; currency: string }
export interface OperationResult { externalSku?: string; ok: boolean; errorCode?: string; message?: string; retryable?: boolean }
export interface ShipmentInput { externalOrderId: string; carrier?: string; weightGrams?: number }
export interface ShipmentResult { trackingNumber: string; carrier: string; labelUrl?: string }

export const WEBHOOK_EVENT_TYPES = ['order.created', 'order.updated', 'order.cancelled', 'listing.status_changed', 'inventory.updated', 'return.created'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface NormalizedWebhook {
  eventType: WebhookEventType;
  /** the marketplace's own event id (used for de-duplication) */
  externalId: string;
  idempotencyKey: string;
  payload: unknown;
  /** present when the event carries the order */
  order?: NormalizedOrder;
  externalOrderId?: string;
  listing?: ListingStatusReport;
}

export interface MarketplaceConnector {
  readonly code: MarketplaceCode;
  readonly displayName: string;
  /** planned = contract + capability declaration only (core refuses to schedule work); beta/ga = implemented and conformance-tested */
  readonly implementation: ImplementationStatus;
  readonly capabilities: ConnectorCapabilities;
  /** sandbox / live access state; `live: false` blocks live accounts at the host (never fake production access) */
  readonly readiness: ConnectorReadiness;
  /** polling plan for data that cannot be pushed to us */
  readonly polling?: PollingStrategy;
  /** how this marketplace's notifications are signed (shown in the webhook configuration) */
  readonly webhook?: { signatureHeader: string; algorithm: string; description: string };

  // -- authenticate / authorize seller
  buildAuthorizationUrl?(input: { state: string; redirectUri: string }): string;
  exchangeAuthorizationCode?(input: { code: string; redirectUri?: string; /** seller id returned by the marketplace's redirect (e.g. selling_partner_id), when the token response does not carry it */ externalAccountId?: string; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }>;
  /** direct credential validation + normalisation (API-key style marketplaces) */
  authenticate?(input: { credentials: ConnectorCredentials; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }>;
  refreshCredentials?(ctx: ConnectorContext): Promise<CredentialSet>;
  verifyConnection(ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }>;

  // -- account / catalogue
  getAccount?(ctx: ConnectorContext): Promise<RemoteAccount>;
  importProducts?(ctx: ConnectorContext, input: { cursor?: string | null; limit?: number }): Promise<Paged<NormalizedProduct>>;

  // -- categories and listing requirements
  searchCategories?(ctx: ConnectorContext, input: { query?: string; parentId?: string | null }): Promise<MarketplaceCategory[]>;
  getCategoryRequirements?(ctx: ConnectorContext, input: { marketplaceCategoryId: string }): Promise<ListingRequirement[]>;

  // -- listings
  previewListing?(input: ListingInput): ListingPreview;
  createListing?(ctx: ConnectorContext, input: ListingInput): Promise<ListingResult>;
  updateListing?(ctx: ConnectorContext, input: ListingInput & { externalListingId: string }): Promise<ListingResult>;
  deactivateListing?(ctx: ConnectorContext, input: { externalSku: string; externalListingId?: string }): Promise<OperationResult>;
  getListingStatus?(ctx: ConnectorContext, input: { externalSku: string; externalListingId?: string }): Promise<ListingStatusReport>;

  // -- inventory, pricing
  pushInventory?(ctx: ConnectorContext, updates: InventoryUpdate[]): Promise<OperationResult[]>;
  pushPrices?(ctx: ConnectorContext, updates: PriceUpdate[]): Promise<OperationResult[]>;

  // -- orders, returns, shipping
  fetchOrders?(ctx: ConnectorContext, input: { since: Date; cursor?: string | null }): Promise<Paged<NormalizedOrder>>;
  /** a single order by marketplace id (webhook notifications often carry only the id) */
  getOrder?(ctx: ConnectorContext, input: { externalOrderId: string }): Promise<NormalizedOrder | null>;
  /** internal status -> the marketplace status/operation to request, or null when it cannot be requested */
  canRequestOrderStatus?(status: InternalOrderStatus): boolean;
  updateOrderStatus?(ctx: ConnectorContext, input: { externalOrderId: string; status: InternalOrderStatus; items?: Array<{ externalItemId: string; sku: string; quantity: number }>; tracking?: { number: string; carrier: string } }): Promise<OperationResult & { marketplaceStatus?: string }>;
  cancelOrder?(ctx: ConnectorContext, input: { externalOrderId: string; reason?: string }): Promise<OperationResult>;
  fetchReturns?(ctx: ConnectorContext, input: { since: Date; cursor?: string | null }): Promise<Paged<NormalizedReturn>>;
  createShipment?(ctx: ConnectorContext, input: ShipmentInput): Promise<ShipmentResult>;

  // -- webhooks
  verifyWebhook?(input: { headers: Record<string, string | undefined>; rawBody: Buffer; secret: string }): boolean;
  parseWebhook?(input: { headers: Record<string, string | undefined>; body: unknown }): NormalizedWebhook | null;
}

/** Throw when core calls an operation the connector doesn't support; always check capabilities first. */
export const unsupported = (code: MarketplaceCode, op: string): AppError => Errors.notImplemented(`${code}.${op}`);

export class ConnectorRegistry {
  private readonly connectors = new Map<MarketplaceCode, MarketplaceConnector>();

  register(connector: MarketplaceConnector): this {
    if (this.connectors.has(connector.code)) throw new Error(`Connector already registered: ${connector.code}`);
    this.connectors.set(connector.code, connector);
    return this;
  }

  has(code: string): boolean { return this.connectors.has(code as MarketplaceCode); }

  get(code: string): MarketplaceConnector {
    const c = this.connectors.get(code as MarketplaceCode);
    if (!c) throw Errors.notFound('Marketplace connector', code);
    return c;
  }

  list(): MarketplaceConnector[] { return [...this.connectors.values()]; }

  /** e.g. registry.supporting(c => c.capabilities.orders.fetch) */
  supporting(pred: (c: MarketplaceConnector) => boolean): MarketplaceConnector[] { return this.list().filter(pred); }
}

export type { InternalListingStatus, InternalOrderStatus };

export { CircuitBreaker, TimeoutError, withTimeout } from './resilience';
