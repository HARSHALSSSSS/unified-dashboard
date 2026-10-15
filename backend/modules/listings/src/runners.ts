import { and, eq, inArray, schema, sql, withVendor } from '@oms/database';
import { requireCapability } from '@oms/marketplace-core';
import { AppError } from '@oms/shared';
import { enqueueSyncJob, executeSyncJob, type SyncRunner } from '@oms/mod-sync';
import type { JobHandler } from '@oms/module-kit';
import { inventoryRunner, pricesRunner } from './channel';
import { loadListingContext } from './context';
import { fx, systemCtx } from './ctx';
import { fromReport } from './domain';
import { catalogImportRunner } from './imports';
import { applyStatusReport, storedRequirements } from './service';

const L = schema.marketplaceListings;

/**
 * Publish / unpublish. The merchant already approved this exact content (hash). The runner submits it, records what the
 * marketplace answered (status + issues) and hands over to status tracking. Safe to retry: the connectors submit by SKU.
 */
const publishRunner: SyncRunner = async (ctx): Promise<{ stats: Record<string, number> }> => {
  const { c, vendorId, accountId, host, payload } = ctx;
  const listingId = String(payload.listingId ?? '');
  const action = payload.action === 'unpublish' ? 'unpublish' : 'publish';
  const sctx = systemCtx(c, vendorId, 'listing-publisher');
  const db = c.database.db;
  if (!listingId || !accountId) throw new AppError('BAD_REQUEST', 'listing job needs listingId and an account');

  if (action === 'unpublish') {
    const l = await withVendor(db, vendorId, async (tx) => (await tx.select().from(L).where(and(eq(L.id, listingId), eq(L.vendorId, vendorId))))[0]);
    if (!l) throw new AppError('NOT_FOUND', 'Listing not found', { details: { resource: 'listing', id: listingId } });
    const res = await host.run(vendorId, accountId, async (conn, cctx) => {
      requireCapability(conn, 'listings.deactivate');
      return conn.deactivateListing!(cctx, { externalSku: l.externalSku, externalListingId: l.externalListingId ?? undefined });
    });
    if (!res.ok) {
      ctx.addFailure({ ref: l.externalSku, code: res.errorCode, message: res.message ?? 'The marketplace refused to deactivate the listing' });
      await withVendor(db, vendorId, (tx) => tx.update(L).set({ lastErrorCode: res.errorCode ?? 'DEACTIVATE_FAILED' }).where(eq(L.id, l.id)));
      return { stats: { unpublished: 0 } };
    }
    await withVendor(db, vendorId, async (tx) => {
      await tx.update(L).set({ status: 'unpublished', externalStatus: 'deactivated', quantityDirty: false, lastErrorCode: null, version: sql`${L.version} + 1` }).where(eq(L.id, l.id));
      const f = fx(tx, sctx);
      await f.event({ type: 'listing.deactivated', aggregateType: 'listing', aggregateId: l.id, payload: { variantId: l.variantId, accountId } });
      await f.audit({ action: 'listing.unpublish', resourceType: 'listing', resourceId: l.id, before: { status: l.status }, after: { status: 'unpublished' } });
    });
    return { stats: { unpublished: 1 } };
  }

  // ---- publish
  const context = await withVendor(db, vendorId, async (tx) => {
    const row = (await tx.select().from(L).where(and(eq(L.id, listingId), eq(L.vendorId, vendorId))))[0];
    if (!row) throw new AppError('NOT_FOUND', 'Listing not found', { details: { resource: 'listing', id: listingId } });
    return loadListingContext(tx, c, vendorId, listingId, { requirements: storedRequirements(row) });
  });
  const { listing } = context;
  if (listing.status !== 'approved' || listing.approvedHash !== context.hash) {
    // not retryable: the content changed (or the state moved) after the request; the merchant has to approve again
    throw new AppError('LISTING_NOT_READY', 'The listing is no longer approved for this content; approve it again', { details: { status: listing.status } });
  }
  const result = await host.run(vendorId, accountId, async (conn, cctx) => {
    if (listing.externalListingId) { requireCapability(conn, 'listings.update'); return conn.updateListing!(cctx, { ...context.input, externalListingId: listing.externalListingId }); }
    requireCapability(conn, 'listings.create');
    return conn.createListing!(cctx, context.input);
  });
  const status = fromReport(result.status);
  await withVendor(db, vendorId, async (tx) => {
    await tx.update(L).set({
      status, externalListingId: result.externalListingId, externalStatus: result.marketplaceStatus, issues: result.issues, payload: { ...context.input, imageUrls: undefined, imageKeys: context.imageKeys },
      syncHash: context.hash, lastErrorCode: result.issues.find((i) => i.severity === 'error')?.code ?? null, publishedAt: status === 'active' ? new Date() : listing.publishedAt,
      lastPolledAt: new Date(), ...(status === 'active' ? { quantityDirty: true, quantityDirtyAt: new Date() } : {}), version: sql`${L.version} + 1`,
    }).where(eq(L.id, listing.id));
    const f = fx(tx, sctx);
    await f.event({ type: 'listing.submitted', aggregateType: 'listing', aggregateId: listing.id, payload: { status, externalStatus: result.marketplaceStatus, issues: result.issues.length } });
    if (status === 'active') await f.event({ type: 'listing.published', aggregateType: 'listing', aggregateId: listing.id, payload: { variantId: listing.variantId, accountId, externalListingId: result.externalListingId } });
    if (status === 'rejected' || status === 'correction_required') await f.event({ type: 'listing.failed', aggregateType: 'listing', aggregateId: listing.id, payload: { status, issues: result.issues.slice(0, 20) } });
    await f.audit({ action: 'listing.publish', resourceType: 'listing', resourceId: listing.id, before: { status: listing.status }, after: { status, externalListingId: result.externalListingId, externalStatus: result.marketplaceStatus } });
  });
  if (status === 'pending') {
    // track the outcome: one coalesced status job per account
    await enqueueSyncJob(c, { vendorId, accountId, type: 'listing_status', trigger: 'event', coalesce: true, idempotencyKey: `listing-status:${accountId}:${listing.id}:${Date.now()}`, payload: { listingIds: [listing.id] } });
  }
  if (status === 'rejected' || status === 'correction_required') ctx.addFailure({ ref: listing.externalSku, code: result.issues[0]?.code ?? status, message: result.issues[0]?.message ?? `The marketplace answered: ${result.marketplaceStatus}` });
  return { stats: { submitted: 1, active: status === 'active' ? 1 : 0, pending: status === 'pending' ? 1 : 0, rejected: status === 'rejected' || status === 'correction_required' ? 1 : 0 } };
};

/** poll the marketplace for the status of submitted listings (specific ones, or every pending listing of the account) */
const statusRunner: SyncRunner = async (ctx) => {
  const { c, vendorId, accountId, host, payload } = ctx;
  if (!accountId) throw new AppError('BAD_REQUEST', 'status check needs an account');
  const db = c.database.db;
  const ids = (payload.listingIds as string[] | undefined) ?? [];
  const sctx = systemCtx(c, vendorId, 'listing-status');
  const listings = await withVendor(db, vendorId, (tx) =>
    tx.select().from(L).where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, accountId), ids.length ? inArray(L.id, ids) : eq(L.status, 'pending'))).orderBy(L.createdAt).limit(200),
  );
  await ctx.progress({ total: listings.length, done: 0, failed: 0 });
  let changed = 0;
  let done = 0;
  for (const l of listings) {
    if (!['pending', 'active', 'rejected', 'correction_required', 'unpublished'].includes(l.status)) { done++; continue; }
    try {
      const report = await host.run(vendorId, accountId, async (conn, cctx) => {
        requireCapability(conn, 'listings.statusLookup');
        return conn.getListingStatus!(cctx, { externalSku: l.externalSku, externalListingId: l.externalListingId ?? undefined });
      });
      const res = await withVendor(db, vendorId, async (tx) => {
        const [fresh] = await tx.select().from(L).where(eq(L.id, l.id));
        return applyStatusReport(tx, sctx, fresh!, report, 'poll');
      });
      if (res.changed) changed++;
    } catch (e) {
      // one listing failing must not stop the others; auth / outage errors still abort and retry the whole job
      if (e instanceof AppError && ['NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED'].includes(e.code)) ctx.addFailure({ ref: l.externalSku, code: e.code, message: e.message });
      else if (e instanceof AppError && e.code === 'UPSTREAM_ERROR' && (e.details as { kind?: string } | undefined)?.kind === 'permanent') ctx.addFailure({ ref: l.externalSku, code: String((e.details as { code?: string }).code ?? 'REJECTED'), message: e.message });
      else throw e;
    }
    done++;
    await ctx.progress({ done });
  }
  // listings that became active need their channel quantity pushed: the next inventory job does it (flags set by applyStatusReport)
  if (changed > 0) {
    await enqueueSyncJob(c, { vendorId, accountId, type: 'inventory', trigger: 'event', coalesce: true, idempotencyKey: `inventory:${accountId}:status-${Date.now()}` });
  }
  return { stats: { checked: listings.length, changed } };
};

const wrap = (name: string, queue: 'syncMarketplace' | 'marketplacePush', runner: SyncRunner): JobHandler => ({ queue, name, handle: (env, c) => executeSyncJob(c, env, runner) });

export const listingJobHandlers: JobHandler[] = [
  wrap('sync.listing_publish', 'marketplacePush', publishRunner),
  wrap('sync.listing_status', 'syncMarketplace', statusRunner),
  wrap('sync.catalog_import', 'syncMarketplace', catalogImportRunner),
  wrap('sync.inventory', 'marketplacePush', inventoryRunner),
  wrap('sync.prices', 'marketplacePush', pricesRunner),
];
