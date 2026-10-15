import { and, eq, inArray, schema, sql, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { effects, type OpCtx } from '@oms/module-kit';
import { barcodeMatches } from './domain';
import { FI, F, getFulfillment, itemsOf, moveFulfillment, numberFor, type Work } from './core';

const P = schema.packages;
const PI = schema.packageItems;
export type PackageRow = typeof P.$inferSelect;

export async function loadPackage(tx: Tx, vendorId: string, id: string) {
  const [p] = await tx.select().from(P).where(and(eq(P.id, id), eq(P.vendorId, vendorId)));
  if (!p) throw Errors.notFound('Package', id);
  return p;
}

export async function packageDetail(tx: Tx, vendorId: string, id: string) {
  const p = await loadPackage(tx, vendorId, id);
  const items = await tx.select({ i: PI, sku: schema.productVariants.sku, barcode: schema.productVariants.barcode }).from(PI)
    .innerJoin(schema.productVariants, and(eq(schema.productVariants.id, PI.variantId), eq(schema.productVariants.vendorId, PI.vendorId))).where(and(eq(PI.vendorId, vendorId), eq(PI.packageId, id)));
  return toPackageDto(p, items);
}

export const toPackageDto = (p: PackageRow, items: Array<{ i: typeof PI.$inferSelect; sku: string; barcode: string | null }>) => ({
  id: p.id, number: p.number, fulfillmentId: p.fulfillmentId, warehouseId: p.warehouseId, status: p.status as (typeof schema.PACKAGE_STATUSES)[number], barcode: p.barcode, boxType: p.boxType,
  weightGrams: p.weightGrams, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, shipmentId: p.shipmentId, packedAt: p.packedAt ? p.packedAt.toISOString() : null,
  items: items.map(({ i, sku, barcode }) => ({ id: i.id, fulfillmentItemId: i.fulfillmentItemId, variantId: i.variantId, sku, barcode, quantity: i.quantity, verified: i.verified })),
  version: p.version, createdAt: p.createdAt.toISOString(),
});

export interface Dimensions { weightGrams?: number | null; lengthMm?: number | null; widthMm?: number | null; heightMm?: number | null; boxType?: string | null }

/** units of a fulfillment item already assigned to live (open/packed/shipped) packages */
async function assigned(tx: Tx, vendorId: string, fulfillmentItemId: string, excludePackage?: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(${PI.quantity}), 0)::int` }).from(PI).innerJoin(P, and(eq(P.id, PI.packageId), eq(P.vendorId, PI.vendorId)))
    .where(and(eq(PI.vendorId, vendorId), eq(PI.fulfillmentItemId, fulfillmentItemId), inArray(P.status, ['open', 'packed', 'shipped']), excludePackage ? sql`${P.id} <> ${excludePackage}` : undefined));
  return r?.n ?? 0;
}

/** Open a package and put picked units in it (an order can ship in several parcels). The fulfillment moves to `packing`. */
export async function createPackage(tx: Tx, ctx: OpCtx, w: Work, fulfillmentId: string, input: Dimensions & { items: Array<{ fulfillmentItemId: string; quantity: number }> }) {
  const f = await getFulfillment(tx, ctx.vendorId, fulfillmentId);
  if (!['picked', 'packing'].includes(f.status)) throw new AppError('INVALID_STATE', `A ${f.status} fulfillment cannot be packed`, { details: { status: f.status } });
  const items = await itemsOf(tx, ctx.vendorId, fulfillmentId);
  const rows: Array<{ fulfillmentItemId: string; variantId: string; quantity: number }> = [];
  for (const line of input.items) {
    const it = items.find((i) => i.id === line.fulfillmentItemId);
    if (!it) throw new AppError('BAD_REQUEST', 'The item does not belong to this fulfillment', { details: { fulfillmentItemId: line.fulfillmentItemId } });
    const free = it.pickedQuantity - (await assigned(tx, ctx.vendorId, it.id));
    if (line.quantity > free) throw new AppError('BAD_REQUEST', 'More units than are picked and not yet in a package', { details: { fulfillmentItemId: it.id, available: free, requested: line.quantity } });
    rows.push({ fulfillmentItemId: it.id, variantId: it.variantId, quantity: line.quantity });
  }
  const number = await numberFor(tx, ctx.vendorId, 'package');
  const [p] = await tx.insert(P).values({ vendorId: ctx.vendorId, number, fulfillmentId, warehouseId: f.warehouseId, barcode: number, boxType: input.boxType ?? null, weightGrams: input.weightGrams ?? null, lengthMm: input.lengthMm ?? null, widthMm: input.widthMm ?? null, heightMm: input.heightMm ?? null }).returning();
  await tx.insert(PI).values(rows.map((r) => ({ vendorId: ctx.vendorId, packageId: p!.id, ...r })));
  if (f.status === 'picked') await moveFulfillment(tx, ctx, w, fulfillmentId, 'packing');
  await effects(tx, ctx).audit({ action: 'package.created', resourceType: 'package', resourceId: p!.id, after: { number, fulfillmentId, items: rows.length } });
  return packageDetail(tx, ctx.vendorId, p!.id);
}

/** Scan an item into an open package: confirms that unit type is the right one for this parcel. */
export async function scanPackageItem(tx: Tx, ctx: OpCtx, packageId: string, input: { itemBarcode: string }) {
  const p = await loadPackage(tx, ctx.vendorId, packageId);
  if (p.status !== 'open') throw new AppError('INVALID_STATE', `This package is ${p.status}`, { details: { status: p.status } });
  const lines = await tx.select({ i: PI, sku: schema.productVariants.sku, barcode: schema.productVariants.barcode }).from(PI)
    .innerJoin(schema.productVariants, and(eq(schema.productVariants.id, PI.variantId), eq(schema.productVariants.vendorId, PI.vendorId))).where(and(eq(PI.vendorId, ctx.vendorId), eq(PI.packageId, packageId)));
  const hit = lines.find((l) => barcodeMatches(input.itemBarcode, { barcode: l.barcode, sku: l.sku }));
  if (!hit) throw new AppError('BAD_REQUEST', 'This item is not part of the package', { details: { rule: 'wrong_item', scanned: input.itemBarcode, expected: lines.map((l) => l.sku) } });
  await tx.update(PI).set({ verified: true }).where(eq(PI.id, hit.i.id));
  return packageDetail(tx, ctx.vendorId, packageId);
}

/** Update box / weight / dimensions while the package is open or packed (not yet shipped). */
export async function setDimensions(tx: Tx, ctx: OpCtx, packageId: string, d: Dimensions) {
  const p = await loadPackage(tx, ctx.vendorId, packageId);
  if (!['open', 'packed'].includes(p.status)) throw new AppError('INVALID_STATE', `This package is ${p.status}`, { details: { status: p.status } });
  await tx.update(P).set({ boxType: d.boxType === undefined ? p.boxType : d.boxType, weightGrams: d.weightGrams === undefined ? p.weightGrams : d.weightGrams, lengthMm: d.lengthMm === undefined ? p.lengthMm : d.lengthMm, widthMm: d.widthMm === undefined ? p.widthMm : d.widthMm, heightMm: d.heightMm === undefined ? p.heightMm : d.heightMm, version: sql`${P.version} + 1` }).where(eq(P.id, packageId));
  await effects(tx, ctx).audit({ action: 'package.updated', resourceType: 'package', resourceId: packageId, before: { weightGrams: p.weightGrams, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm }, after: d });
  return packageDetail(tx, ctx.vendorId, packageId);
}

/**
 * Close the package: every item must have been verified by a barcode scan (or `override`), and it needs a weight. When every
 * picked unit of the fulfillment is in a closed package the fulfillment becomes `packed`.
 */
export async function closePackage(tx: Tx, ctx: OpCtx, w: Work, packageId: string, input: Dimensions & { override?: boolean } = {}) {
  await getFulfillment(tx, ctx.vendorId, (await loadPackage(tx, ctx.vendorId, packageId)).fulfillmentId, true); // serialise packing work per fulfillment
  const p = await loadPackage(tx, ctx.vendorId, packageId);
  if (p.status !== 'open') throw new AppError('INVALID_STATE', `This package is ${p.status}`, { details: { status: p.status } });
  const weight = input.weightGrams ?? p.weightGrams;
  if (!weight) throw new AppError('BAD_REQUEST', 'A weight is required to close a package', { details: { rule: 'weight_required' } });
  const lines = await tx.select().from(PI).where(and(eq(PI.vendorId, ctx.vendorId), eq(PI.packageId, packageId)));
  const unverified = lines.filter((l) => !l.verified);
  if (unverified.length && !input.override) throw new AppError('CONFLICT', 'Scan every item before closing the package (or close with override)', { details: { rule: 'scan_required', unverified: unverified.length } });
  if (unverified.length) await effects(tx, ctx).audit({ action: 'package.close_override', resourceType: 'package', resourceId: packageId, metadata: { unverified: unverified.length } });
  await tx.update(P).set({ status: 'packed', packedAt: new Date(), packedBy: ctx.actor.id && /^[0-9a-f-]{36}$/i.test(ctx.actor.id) ? ctx.actor.id : null, weightGrams: weight, boxType: input.boxType ?? p.boxType, lengthMm: input.lengthMm ?? p.lengthMm, widthMm: input.widthMm ?? p.widthMm, heightMm: input.heightMm ?? p.heightMm, version: sql`${P.version} + 1` }).where(eq(P.id, packageId));
  for (const l of lines) await tx.update(FI).set({ packedQuantity: sql`${FI.packedQuantity} + ${l.quantity}` }).where(eq(FI.id, l.fulfillmentItemId));
  const items = await itemsOf(tx, ctx.vendorId, p.fulfillmentId);
  const f = await getFulfillment(tx, ctx.vendorId, p.fulfillmentId);
  if (f.status === 'packing' && items.every((i) => i.packedQuantity >= i.pickedQuantity) && items.some((i) => i.packedQuantity > 0)) await moveFulfillment(tx, ctx, w, p.fulfillmentId, 'packed');
  return packageDetail(tx, ctx.vendorId, packageId);
}

/** Cancel a package that has not shipped; its units become packable again (and a `packed` fulfillment steps back to `packing`). */
export async function cancelPackage(tx: Tx, ctx: OpCtx, w: Work, packageId: string, reason?: string | null) {
  const p = await loadPackage(tx, ctx.vendorId, packageId);
  if (!['open', 'packed'].includes(p.status)) throw new AppError('INVALID_STATE', `A ${p.status} package cannot be cancelled`, { details: { status: p.status } });
  if (p.shipmentId) throw new AppError('CONFLICT', 'The package is on a shipment; void the shipment first', { details: { rule: 'on_shipment', shipmentId: p.shipmentId } });
  if (p.status === 'packed') for (const l of await tx.select().from(PI).where(and(eq(PI.vendorId, ctx.vendorId), eq(PI.packageId, packageId)))) await tx.update(FI).set({ packedQuantity: sql`${FI.packedQuantity} - ${l.quantity}` }).where(eq(FI.id, l.fulfillmentItemId));
  await tx.update(P).set({ status: 'cancelled', version: sql`${P.version} + 1` }).where(eq(P.id, packageId));
  await effects(tx, ctx).audit({ action: 'package.cancelled', resourceType: 'package', resourceId: packageId, before: { status: p.status }, after: { status: 'cancelled', reason: reason ?? null } });
  const f = await getFulfillment(tx, ctx.vendorId, p.fulfillmentId);
  if (f.status === 'packed') await moveFulfillment(tx, ctx, w, p.fulfillmentId, 'packing', { note: `package ${p.number} cancelled` });
  else if (f.status === 'ready_to_ship') { await moveFulfillment(tx, ctx, w, p.fulfillmentId, 'packed', { note: `package ${p.number} cancelled` }); await moveFulfillment(tx, ctx, w, p.fulfillmentId, 'packing'); }
  return packageDetail(tx, ctx.vendorId, packageId);
}

export async function listPackages(tx: Tx, vendorId: string, q: { fulfillmentId?: string; status?: string; warehouseId?: string }) {
  const rows = await tx.select().from(P).where(and(eq(P.vendorId, vendorId), q.fulfillmentId ? eq(P.fulfillmentId, q.fulfillmentId) : undefined, q.status ? eq(P.status, q.status) : undefined, q.warehouseId ? eq(P.warehouseId, q.warehouseId) : undefined)).orderBy(P.createdAt).limit(200);
  return Promise.all(rows.map((p) => packageDetail(tx, vendorId, p.id)));
}

/** The packer's queue: fulfillments that are picked / being packed, with what is still to put in a package. */
export async function packingTasks(tx: Tx, vendorId: string, q: { warehouseId?: string; allowedWarehouses?: string[] | null; limit: number }) {
  const fs = await tx.select().from(F).where(and(eq(F.vendorId, vendorId), inArray(F.status, ['picked', 'packing']), q.warehouseId ? eq(F.warehouseId, q.warehouseId) : undefined,
    q.allowedWarehouses ? (q.allowedWarehouses.length ? inArray(F.warehouseId, q.allowedWarehouses) : sql`false`) : undefined)).orderBy(F.createdAt).limit(q.limit);
  const out = [];
  for (const f of fs) {
    const items = await tx.select({ i: FI, sku: schema.productVariants.sku, barcode: schema.productVariants.barcode }).from(FI).innerJoin(schema.productVariants, and(eq(schema.productVariants.id, FI.variantId), eq(schema.productVariants.vendorId, FI.vendorId))).where(and(eq(FI.vendorId, vendorId), eq(FI.fulfillmentId, f.id)));
    out.push({ fulfillmentId: f.id, number: f.number, orderId: f.orderId, warehouseId: f.warehouseId, status: f.status, priority: f.priority, items: items.map(({ i, sku, barcode }) => ({ fulfillmentItemId: i.id, sku, barcode, variantId: i.variantId, picked: i.pickedQuantity, packed: i.packedQuantity, toPack: i.pickedQuantity - i.packedQuantity })) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// hand-over to shipping (shipping never writes fulfillment tables itself)
// ------------------------------------------------------------------------------------------------
/** closed (packed) packages of a fulfillment that are not on a shipment yet */
export async function packagesForShipment(tx: Tx, vendorId: string, fulfillmentId: string): Promise<PackageRow[]> {
  return tx.select().from(P).where(and(eq(P.vendorId, vendorId), eq(P.fulfillmentId, fulfillmentId), eq(P.status, 'packed'))).orderBy(P.createdAt);
}
export async function attachPackages(tx: Tx, vendorId: string, fulfillmentId: string, shipmentId: string | null): Promise<void> {
  await tx.update(P).set({ shipmentId }).where(and(eq(P.vendorId, vendorId), eq(P.fulfillmentId, fulfillmentId), shipmentId ? eq(P.status, 'packed') : sql`${P.shipmentId} IS NOT NULL AND ${P.status} <> 'shipped'`));
}
export async function markPackagesShipped(tx: Tx, vendorId: string, shipmentId: string): Promise<PackageRow[]> {
  return tx.update(P).set({ status: 'shipped' }).where(and(eq(P.vendorId, vendorId), eq(P.shipmentId, shipmentId))).returning();
}
