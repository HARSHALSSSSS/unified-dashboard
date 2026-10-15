import { and, eq, escapeLike, ilike, inArray, keyset, or, schema, sql, withVendor, type SQL, type Tx } from '@oms/database';
import { requireCapability, type ListingIssue, type ListingRequirement, type ListingStatusReport } from '@oms/marketplace-core';
import { AppError, Errors } from '@oms/shared';
import { createSyncJob, dispatchSyncJob, enqueueSyncJob, type SyncJobRow } from '@oms/mod-sync';
import { getListingRow, loadListingContext, type ListingContext, type ListingRow } from './context';
import type { Ctx } from './ctx';
import { fx } from './ctx';
import { EDITABLE, fromReport, validateListingInput, type ListingStatus, type ValidationResult } from './domain';
import { categoryRequirements } from './mappings';

const L = schema.marketplaceListings;
const V = schema.productVariants;
const P = schema.products;
const A = schema.marketplaceAccounts;

// ------------------------------------------------------------------------------------------------
// DTO
// ------------------------------------------------------------------------------------------------
export interface ListingJoin { l: ListingRow; sku: string; productId: string; productTitle: string; marketplace: string; variantPriceMinor: number | null; variantMrpMinor: number | null }

export const toListingDto = (r: ListingJoin) => {
  const v = r.l.validation as { ready?: boolean; errors?: unknown[]; warnings?: unknown[]; hash?: string; validatedAt?: string };
  return {
    id: r.l.id, marketplaceAccountId: r.l.marketplaceAccountId, marketplace: r.marketplace, variantId: r.l.variantId, productId: r.productId, sku: r.sku, productTitle: r.productTitle,
    externalSku: r.l.externalSku, externalListingId: r.l.externalListingId, status: r.l.status as ListingStatus, externalStatus: r.l.externalStatus, source: r.l.source as 'created' | 'imported',
    marketplaceCategoryId: r.l.marketplaceCategoryId, currency: r.l.currency.trim(),
    priceMinor: r.l.priceMinor, mrpMinor: r.l.mrpMinor, effectivePriceMinor: r.l.priceMinor ?? r.variantPriceMinor, effectiveMrpMinor: r.l.mrpMinor ?? r.variantMrpMinor,
    attributeValues: r.l.attributeValues, issues: r.l.issues as ListingIssue[],
    validation: v?.validatedAt ? { ready: Boolean(v.ready), errorCount: v.errors?.length ?? 0, warningCount: v.warnings?.length ?? 0, validatedAt: v.validatedAt } : null,
    approval: { approved: r.l.status === 'approved' || r.l.approvedAt !== null, approvedAt: r.l.approvedAt ? r.l.approvedAt.toISOString() : null, approvedBy: r.l.approvedBy },
    publishedAt: r.l.publishedAt ? r.l.publishedAt.toISOString() : null, lastPolledAt: r.l.lastPolledAt ? r.l.lastPolledAt.toISOString() : null,
    quantity: { sellable: r.l.sellableQuantity, pushed: r.l.pushedQuantity, dirty: r.l.quantityDirty, pushedAt: r.l.quantityPushedAt ? r.l.quantityPushedAt.toISOString() : null },
    bufferOverride: r.l.bufferOverride, maxQuantityOverride: r.l.maxQuantityOverride, version: r.l.version, createdAt: r.l.createdAt.toISOString(), updatedAt: r.l.updatedAt.toISOString(),
  };
};

async function joined(tx: Tx, vendorId: string, where: SQL | undefined, extra?: { limit?: number; order?: SQL[] }): Promise<ListingJoin[]> {
  const q = tx
    .select({ l: L, sku: V.sku, productId: P.id, productTitle: P.title, marketplace: A.marketplace, variantPriceMinor: V.sellingPriceMinor, variantMrpMinor: V.mrpMinor })
    .from(L)
    .innerJoin(V, and(eq(V.id, L.variantId), eq(V.vendorId, L.vendorId)))
    .innerJoin(P, and(eq(P.id, V.productId), eq(P.vendorId, V.vendorId)))
    .innerJoin(A, and(eq(A.id, L.marketplaceAccountId), eq(A.vendorId, L.vendorId)))
    .where(and(eq(L.vendorId, vendorId), where));
  return extra?.order ? q.orderBy(...extra.order).limit(extra.limit ?? 100) : q;
}

export async function getListingDto(tx: Tx, vendorId: string, id: string) {
  const [row] = await joined(tx, vendorId, eq(L.id, id));
  if (!row) throw Errors.notFound('Listing', id);
  return toListingDto(row);
}

export interface ListingFilter { limit: number; cursor?: string; sort?: Array<{ field: string; direction: 'asc' | 'desc' }>; q?: string; status?: string; accountId?: string; variantId?: string; marketplace?: string; source?: string }

export async function listListings(tx: Tx, vendorId: string, f: ListingFilter) {
  const ks = keyset<ListingJoin>({ sorts: { createdAt: { column: L.createdAt, kind: 'timestamp' }, updatedAt: { column: L.updatedAt, kind: 'timestamp' } }, idColumn: L.id, sort: f.sort, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: f.cursor, limit: f.limit });
  const field = f.sort?.[0]?.field ?? 'createdAt';
  const search = f.q ? or(ilike(L.externalSku, `%${escapeLike(f.q)}%`), ilike(P.title, `%${escapeLike(f.q)}%`), ilike(V.sku, `%${escapeLike(f.q)}%`)) : undefined;
  const rows = await joined(
    tx, vendorId,
    and(f.status ? eq(L.status, f.status) : undefined, f.accountId ? eq(L.marketplaceAccountId, f.accountId) : undefined, f.variantId ? eq(L.variantId, f.variantId) : undefined, f.marketplace ? eq(A.marketplace, f.marketplace) : undefined, f.source ? eq(L.source, f.source) : undefined, search, ks.where),
    { limit: ks.fetch, order: ks.orderBy },
  );
  const page = ks.finish(rows, (r) => ({ sortValue: field === 'updatedAt' ? r.l.updatedAt : r.l.createdAt, id: r.l.id }));
  return { items: page.items.map(toListingDto), nextCursor: page.nextCursor };
}

// ------------------------------------------------------------------------------------------------
// create / edit / delete
// ------------------------------------------------------------------------------------------------
export interface CreateListingInput {
  marketplaceAccountId: string; variantId: string; externalSku?: string; marketplaceCategoryId?: string | null; priceMinor?: number | null; mrpMinor?: number | null;
  attributeValues?: Record<string, string | number | boolean>; bufferOverride?: number | null; maxQuantityOverride?: number | null;
}

export async function createListing(tx: Tx, ctx: Ctx, input: CreateListingInput) {
  const { vendorId, c } = ctx;
  const [acc] = await tx.select().from(A).where(and(eq(A.id, input.marketplaceAccountId), eq(A.vendorId, vendorId)));
  if (!acc) throw Errors.notFound('Marketplace account', input.marketplaceAccountId);
  if (acc.status === 'revoked') throw new AppError('ACCOUNT_NOT_CONNECTED', 'This marketplace account was disconnected', { details: { status: acc.status } });
  const connector = c.connectors.get(acc.marketplace);
  if (connector.implementation === 'planned') throw new AppError('CAPABILITY_UNSUPPORTED', `${connector.displayName} is not available yet`);
  requireCapability(connector, 'listings.create');
  const [variant] = await tx.select().from(V).where(and(eq(V.id, input.variantId), eq(V.vendorId, vendorId), sql`${V.deletedAt} IS NULL`));
  if (!variant) throw Errors.notFound('Variant', input.variantId);

  const [dup] = await tx.select({ id: L.id }).from(L).where(and(eq(L.marketplaceAccountId, acc.id), eq(L.variantId, variant.id)));
  if (dup) throw new AppError('CONFLICT', 'This variant already has a listing on this marketplace account', { details: { field: 'variantId', listingId: dup.id } });
  const sku = input.externalSku ?? variant.sku;
  const [skuDup] = await tx.select({ id: L.id }).from(L).where(and(eq(L.marketplaceAccountId, acc.id), eq(L.externalSku, sku)));
  if (skuDup) throw new AppError('CONFLICT', 'That marketplace SKU is already used by another listing on this account', { details: { field: 'externalSku', listingId: skuDup.id } });

  const [row] = await tx
    .insert(L)
    .values({
      vendorId, marketplaceAccountId: acc.id, variantId: variant.id, externalSku: sku, status: 'draft', currency: variant.currency, priceMinor: input.priceMinor ?? null, mrpMinor: input.mrpMinor ?? null,
      marketplaceCategoryId: input.marketplaceCategoryId ?? null, attributeValues: input.attributeValues ?? {}, bufferOverride: input.bufferOverride ?? null, maxQuantityOverride: input.maxQuantityOverride ?? null, source: 'created',
    })
    .returning();
  const f = fx(tx, ctx);
  await f.event({ type: 'listing.created', aggregateType: 'listing', aggregateId: row!.id, payload: { marketplace: acc.marketplace, variantId: variant.id, accountId: acc.id } });
  await f.audit({ action: 'listing.create', resourceType: 'listing', resourceId: row!.id, after: { marketplace: acc.marketplace, sku, accountId: acc.id } });
  return getListingDto(tx, vendorId, row!.id);
}

export interface UpdateListingInput {
  externalSku?: string; marketplaceCategoryId?: string | null; priceMinor?: number | null; mrpMinor?: number | null; attributeValues?: Record<string, string | number | boolean>;
  bufferOverride?: number | null; maxQuantityOverride?: number | null; version?: number;
}

/** what an active/pending (live) listing may still change without unpublishing: price, MRP and channel stock limits */
const LIVE_EDITABLE: ReadonlyArray<keyof UpdateListingInput> = ['priceMinor', 'mrpMinor', 'bufferOverride', 'maxQuantityOverride', 'version'];

export async function updateListing(tx: Tx, ctx: Ctx, id: string, patch: UpdateListingInput): Promise<{ dto: Awaited<ReturnType<typeof getListingDto>>; priceChanged: boolean; stockRulesChanged: boolean }> {
  const before = await getListingRow(tx, ctx.vendorId, id);
  if (patch.version !== undefined && patch.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });
  const isLive = before.status === 'active' || before.status === 'pending';
  if (isLive) {
    const forbidden = Object.keys(patch).filter((k) => !(LIVE_EDITABLE as string[]).includes(k) && (patch as Record<string, unknown>)[k] !== undefined);
    if (forbidden.length) throw new AppError('INVALID_STATE', 'A live listing only allows price, MRP and stock-limit changes; unpublish it to edit its content', { details: { status: before.status, notAllowed: forbidden } });
  } else if (!EDITABLE.includes(before.status as ListingStatus)) {
    throw new AppError('INVALID_STATE', `A ${before.status} listing cannot be edited`, { details: { status: before.status } });
  }
  if (patch.externalSku && patch.externalSku !== before.externalSku) {
    if (before.externalListingId) throw new AppError('INVALID_STATE', 'The marketplace SKU cannot change once the listing exists on the marketplace', { details: { field: 'externalSku' } });
    const [dup] = await tx.select({ id: L.id }).from(L).where(and(eq(L.marketplaceAccountId, before.marketplaceAccountId), eq(L.externalSku, patch.externalSku)));
    if (dup) throw new AppError('CONFLICT', 'That marketplace SKU is already used by another listing on this account', { details: { field: 'externalSku' } });
  }
  const contentChanged = ['externalSku', 'marketplaceCategoryId', 'priceMinor', 'mrpMinor', 'attributeValues'].some((k) => (patch as Record<string, unknown>)[k] !== undefined);
  const set: Partial<typeof L.$inferInsert> = {};
  if (patch.externalSku !== undefined) set.externalSku = patch.externalSku;
  if (patch.marketplaceCategoryId !== undefined) set.marketplaceCategoryId = patch.marketplaceCategoryId;
  if (patch.priceMinor !== undefined) set.priceMinor = patch.priceMinor;
  if (patch.mrpMinor !== undefined) set.mrpMinor = patch.mrpMinor;
  if (patch.attributeValues !== undefined) set.attributeValues = patch.attributeValues;
  if (patch.bufferOverride !== undefined) set.bufferOverride = patch.bufferOverride;
  if (patch.maxQuantityOverride !== undefined) set.maxQuantityOverride = patch.maxQuantityOverride;
  // editing content invalidates validation and approval (the merchant approved something else)
  if (contentChanged && !isLive) Object.assign(set, { status: before.status === 'rejected' || before.status === 'correction_required' || before.status === 'unpublished' ? before.status : 'draft', approvedHash: null, approvedAt: null, approvedBy: null, validation: {} });
  await tx.update(L).set({ ...set, version: sql`${L.version} + 1` }).where(eq(L.id, id));
  const f = fx(tx, ctx);
  await f.audit({ action: 'listing.update', resourceType: 'listing', resourceId: id, before: { status: before.status, priceMinor: before.priceMinor }, after: set });
  const dto = await getListingDto(tx, ctx.vendorId, id);
  return { dto, priceChanged: patch.priceMinor !== undefined && patch.priceMinor !== before.priceMinor && isLive, stockRulesChanged: patch.bufferOverride !== undefined || patch.maxQuantityOverride !== undefined };
}

export async function deleteListing(tx: Tx, ctx: Ctx, id: string) {
  const l = await getListingRow(tx, ctx.vendorId, id);
  if (l.externalListingId || ['active', 'pending'].includes(l.status)) throw new AppError('INVALID_STATE', 'Only a listing that never reached the marketplace can be deleted; unpublish it instead', { details: { status: l.status } });
  await tx.delete(L).where(eq(L.id, id));
  await fx(tx, ctx).audit({ action: 'listing.delete', resourceType: 'listing', resourceId: id, before: { sku: l.externalSku, status: l.status } });
}

// ------------------------------------------------------------------------------------------------
// validate / preview / approve
// ------------------------------------------------------------------------------------------------
export interface Evaluation { context: ListingContext; requirements: ListingRequirement[]; result: ValidationResult }

/** Loads the listing, asks the marketplace what the category requires and checks the resolved listing against it. No writes. */
export async function evaluate(ctx: Ctx, listingId: string, opts: { signImages?: boolean } = {}): Promise<Evaluation> {
  const { c, vendorId } = ctx;
  const db = c.database.db;
  const base = await withVendor(db, vendorId, (tx) => loadListingContext(tx, c, vendorId, listingId, { signImages: false }));
  const connector = c.connectors.get(base.account.marketplace);
  let requirements: ListingRequirement[] = [];
  const unavailable: Array<{ code: string; message: string }> = [];
  if (base.input.marketplaceCategoryId && connector.getCategoryRequirements) {
    try { requirements = await categoryRequirements(c, vendorId, base.account.id, base.input.marketplaceCategoryId); }
    catch (e) {
      if (!(e instanceof AppError)) throw e;
      // we could not prove the listing against the marketplace's rules: that is a blocker, not a pass
      unavailable.push({ code: 'requirements_unavailable', message: e.code === 'NOT_FOUND' ? `The marketplace category "${base.input.marketplaceCategoryId}" does not exist` : `Could not load the category requirements from ${connector.displayName}: ${e.message}` });
    }
  }
  const context = await withVendor(db, vendorId, (tx) => loadListingContext(tx, c, vendorId, listingId, { requirements, signImages: opts.signImages }));
  const result = validateListingInput({ input: context.input, requirements, categoryRequired: connector.capabilities.listings.requiresCategoryMapping, imageCount: context.imageKeys.length });
  result.errors.unshift(...unavailable);
  if (context.account.status !== 'active') result.errors.unshift({ code: 'account_not_connected', message: 'The marketplace account is not connected' });
  if (!connector.capabilities.listings.create) result.errors.unshift({ code: 'capability_unsupported', message: `${connector.displayName} does not support creating listings through the API` });
  result.ready = result.errors.length === 0;
  return { context, requirements, result };
}

export async function validateListing(ctx: Ctx, listingId: string) {
  const ev = await evaluate(ctx, listingId, { signImages: false });
  const { listing } = ev.context;
  return withVendor(ctx.c.database.db, ctx.vendorId, async (tx) => {
    const cur = await getListingRow(tx, ctx.vendorId, listingId);
    const stillApproved = cur.status === 'approved' && cur.approvedHash === ev.context.hash;
    let status = cur.status as ListingStatus;
    if (ev.result.ready) {
      if (['draft', 'ready', 'approved'].includes(status)) status = stillApproved ? 'approved' : 'ready';
    } else if (status === 'ready' || status === 'approved') status = 'draft';
    const validation = { ready: ev.result.ready, errors: ev.result.errors, warnings: ev.result.warnings, hash: ev.context.hash, validatedAt: new Date().toISOString(), requirements: ev.requirements };
    await tx.update(L).set({ validation, status, ...(stillApproved ? {} : { approvedHash: null, approvedAt: null, approvedBy: null }), version: sql`${L.version} + 1` }).where(eq(L.id, listing.id));
    await fx(tx, ctx).audit({ action: 'listing.validate', resourceType: 'listing', resourceId: listing.id, after: { ready: ev.result.ready, errors: ev.result.errors.length, warnings: ev.result.warnings.length } });
    return { listing: await getListingDto(tx, ctx.vendorId, listing.id), validation: { ready: ev.result.ready, errors: ev.result.errors, warnings: ev.result.warnings }, requirements: ev.requirements, attributeSources: ev.context.attributeSources };
  });
}

export async function previewListing(ctx: Ctx, listingId: string) {
  const ev = await evaluate(ctx, listingId);
  const connector = ctx.c.connectors.get(ev.context.account.marketplace);
  const preview = connector.previewListing
    ? connector.previewListing(ev.context.input)
    : { endpoint: `${connector.code}: createListing`, payload: ev.context.input, warnings: ['This connector has no payload preview; showing the normalised listing'] };
  const l = ev.context.listing;
  return {
    marketplace: ev.context.account.marketplace, endpoint: preview.endpoint, payload: preview.payload, warnings: [...preview.warnings, ...ev.result.warnings.map((w) => w.message)],
    validation: { ready: ev.result.ready, errors: ev.result.errors, warnings: ev.result.warnings }, attributeSources: ev.context.attributeSources,
    contentHash: ev.context.hash, approval: { approved: l.approvedHash !== null, current: l.approvedHash === ev.context.hash, approvedAt: l.approvedAt ? l.approvedAt.toISOString() : null },
  };
}

export async function approveListing(ctx: Ctx, listingId: string) {
  const ev = await evaluate(ctx, listingId, { signImages: false });
  const { listing } = ev.context;
  if (!['draft', 'ready', 'approved', 'rejected', 'correction_required', 'unpublished'].includes(listing.status)) throw new AppError('INVALID_STATE', `A ${listing.status} listing cannot be approved`, { details: { status: listing.status } });
  if (!ev.result.ready) throw new AppError('LISTING_NOT_READY', 'Fix the validation errors before approving', { details: { errors: ev.result.errors, warnings: ev.result.warnings } });
  return withVendor(ctx.c.database.db, ctx.vendorId, async (tx) => {
    const actorId = ctx.actor.type === 'user' ? ctx.actor.id : null;
    await tx.update(L).set({
      status: 'approved', approvedHash: ev.context.hash, approvedAt: new Date(), approvedBy: actorId,
      validation: { ready: true, errors: [], warnings: ev.result.warnings, hash: ev.context.hash, validatedAt: new Date().toISOString(), requirements: ev.requirements }, version: sql`${L.version} + 1`,
    }).where(eq(L.id, listing.id));
    const f = fx(tx, ctx);
    await f.event({ type: 'listing.approved', aggregateType: 'listing', aggregateId: listing.id, payload: { hash: ev.context.hash } });
    await f.audit({ action: 'listing.approve', resourceType: 'listing', resourceId: listing.id, after: { hash: ev.context.hash } });
    return getListingDto(tx, ctx.vendorId, listing.id);
  });
}

// ------------------------------------------------------------------------------------------------
// publish / unpublish (asynchronous: a sync job does the marketplace call)
// ------------------------------------------------------------------------------------------------
export async function requestPublish(ctx: Ctx, listingId: string): Promise<{ job: SyncJobRow; created: boolean }> {
  const { c, vendorId } = ctx;
  const res = await withVendor(c.database.db, vendorId, async (tx) => {
    const row = await getListingRow(tx, vendorId, listingId);
    const context = await loadListingContext(tx, c, vendorId, listingId, { signImages: false, requirements: storedRequirements(row) });
    const { listing, account } = context;
    if (listing.status !== 'approved') throw new AppError('LISTING_NOT_READY', 'The merchant must approve the listing before it can be published', { details: { status: listing.status } });
    if (listing.approvedHash !== context.hash) throw new AppError('LISTING_NOT_READY', 'The listing changed after it was approved; validate and approve it again', { details: { reason: 'changed_since_approval' } });
    if (account.status !== 'active') throw new AppError('ACCOUNT_NOT_CONNECTED', undefined, { details: { status: account.status } });
    const connector = c.connectors.get(account.marketplace);
    requireCapability(connector, listing.externalListingId ? 'listings.update' : 'listings.create');
    const r = await createSyncJob(tx, c, { vendorId, accountId: account.id, type: 'listing_publish', trigger: 'manual', idempotencyKey: `publish:${listing.id}:v${listing.version}`, payload: { listingId: listing.id, action: 'publish' }, requestedBy: ctx.actor.type === 'user' ? ctx.actor.id : null });
    await fx(tx, ctx).audit({ action: 'listing.publish_requested', resourceType: 'listing', resourceId: listing.id, metadata: { jobId: r.job.id } });
    return r;
  });
  if (res.created) await dispatchSyncJob(c, res.job);
  return res;
}

export async function requestUnpublish(ctx: Ctx, listingId: string): Promise<{ job: SyncJobRow; created: boolean }> {
  const { c, vendorId } = ctx;
  const res = await withVendor(c.database.db, vendorId, async (tx) => {
    const listing = await getListingRow(tx, vendorId, listingId);
    if (!['active', 'pending'].includes(listing.status)) throw new AppError('INVALID_STATE', `Only an active or pending listing can be unpublished (this one is ${listing.status})`, { details: { status: listing.status } });
    const [account] = await tx.select().from(A).where(and(eq(A.id, listing.marketplaceAccountId), eq(A.vendorId, vendorId)));
    requireCapability(c.connectors.get(account!.marketplace), 'listings.deactivate');
    const r = await createSyncJob(tx, c, { vendorId, accountId: listing.marketplaceAccountId, type: 'listing_publish', trigger: 'manual', idempotencyKey: `unpublish:${listing.id}:v${listing.version}`, payload: { listingId: listing.id, action: 'unpublish' }, requestedBy: ctx.actor.type === 'user' ? ctx.actor.id : null });
    await fx(tx, ctx).audit({ action: 'listing.unpublish_requested', resourceType: 'listing', resourceId: listing.id, metadata: { jobId: r.job.id } });
    return r;
  });
  if (res.created) await dispatchSyncJob(c, res.job);
  return res;
}

/** ask the marketplace for the status of these listings (or every pending one on the account) */
export async function requestStatusRefresh(ctx: Ctx, accountId: string, listingIds?: string[]) {
  return enqueueSyncJob(ctx.c, {
    vendorId: ctx.vendorId, accountId, type: 'listing_status', trigger: 'manual', coalesce: !listingIds, idempotencyKey: `listing-status:${accountId}:${listingIds ? listingIds.join(',').slice(0, 60) : 'all'}:${Date.now()}`,
    payload: listingIds ? { listingIds } : {}, requestedBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
  });
}

// ------------------------------------------------------------------------------------------------
// marketplace status -> listing
// ------------------------------------------------------------------------------------------------
/** Applies a status the marketplace reported (poll or webhook). Idempotent: a repeat of the current status changes nothing. */
export async function applyStatusReport(tx: Tx, ctx: Ctx, listing: ListingRow, report: ListingStatusReport, source: 'poll' | 'webhook' | 'publish'): Promise<{ changed: boolean; status: ListingStatus }> {
  const next = fromReport(report.status);
  const unsubmitted: ListingStatus[] = ['draft', 'ready', 'approved'];
  // a report about a listing we never submitted (or that we have since unpublished locally awaiting confirmation) must not resurrect it
  if (unsubmitted.includes(listing.status as ListingStatus)) return { changed: false, status: listing.status as ListingStatus };
  const changed = listing.status !== next;
  const becameActive = next === 'active' && listing.status !== 'active';
  await tx.update(L).set({
    status: next, externalStatus: report.marketplaceStatus, issues: report.issues, externalListingId: report.externalListingId || listing.externalListingId, lastPolledAt: new Date(),
    lastErrorCode: report.issues.find((i) => i.severity === 'error')?.code ?? null, ...(becameActive ? { publishedAt: new Date(), quantityDirty: true, quantityDirtyAt: new Date() } : {}),
    ...(changed ? { version: sql`${L.version} + 1` } : {}),
  }).where(eq(L.id, listing.id));
  if (changed) {
    const f = fx(tx, ctx);
    await f.event({ type: 'listing.status_changed', aggregateType: 'listing', aggregateId: listing.id, payload: { from: listing.status, to: next, externalStatus: report.marketplaceStatus, source } });
    if (becameActive) await f.event({ type: 'listing.published', aggregateType: 'listing', aggregateId: listing.id, payload: { variantId: listing.variantId, accountId: listing.marketplaceAccountId, externalListingId: report.externalListingId } });
    if (next === 'rejected' || next === 'correction_required') await f.event({ type: 'listing.failed', aggregateType: 'listing', aggregateId: listing.id, payload: { status: next, issues: report.issues.slice(0, 20) } });
    await f.audit({ action: 'listing.status_changed', resourceType: 'listing', resourceId: listing.id, before: { status: listing.status }, after: { status: next, externalStatus: report.marketplaceStatus }, metadata: { source } });
  }
  return { changed, status: next };
}

/** the category requirements the listing was last validated / approved against (no network needed to re-resolve attributes) */
export const storedRequirements = (l: ListingRow): ListingRequirement[] => ((l.validation as { requirements?: ListingRequirement[] }).requirements ?? []);

export const listingsByStatus = async (tx: Tx, vendorId: string, accountId: string, statuses: ListingStatus[], limit = 200): Promise<ListingRow[]> =>
  tx.select().from(L).where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, accountId), inArray(L.status, statuses))).orderBy(L.createdAt).limit(limit);
