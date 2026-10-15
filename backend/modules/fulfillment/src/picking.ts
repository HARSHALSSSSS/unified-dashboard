import { and, eq, inArray, keyset, schema, sql, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { adjustStock, binStockOf, releaseReservedUnits, removeFromBin, suggestBins } from '@oms/mod-inventory';
import { recordShortage } from '@oms/mod-orders';
import { effects, type OpCtx } from '@oms/module-kit';
import { barcodeMatches } from './domain';
import { cancelFulfillment, closeFinishedPickLists, F, FI, getFulfillment, itemsOf, moveFulfillment, numberFor, type Work } from './core';
import { raiseException } from './exceptions';

const PL = schema.pickLists;
const PT = schema.pickTasks;
export type PickListRow = typeof PL.$inferSelect;
export type PickTaskRow = typeof PT.$inferSelect;

export const toTaskDto = (t: PickTaskRow, extra: { sku: string; barcode: string | null; binCode: string | null; binBarcode: string | null }) => ({
  id: t.id, pickListId: t.pickListId, fulfillmentId: t.fulfillmentId, fulfillmentItemId: t.fulfillmentItemId, variantId: t.variantId, sku: extra.sku, barcode: extra.barcode, title: null,
  binId: t.binId, binCode: extra.binCode, binBarcode: extra.binBarcode, sequence: t.sequence, quantity: t.quantity, pickedQuantity: t.pickedQuantity, status: t.status as (typeof schema.PICK_TASK_STATUSES)[number],
  verified: t.verified, pickedBy: t.pickedBy, pickedAt: t.pickedAt ? t.pickedAt.toISOString() : null, notes: t.notes,
});
export const toPickListDto = (l: PickListRow, tasks: ReturnType<typeof toTaskDto>[] = []) => ({
  id: l.id, number: l.number, warehouseId: l.warehouseId, status: l.status as (typeof schema.PICK_LIST_STATUSES)[number], assignedTo: l.assignedTo,
  startedAt: l.startedAt ? l.startedAt.toISOString() : null, completedAt: l.completedAt ? l.completedAt.toISOString() : null, version: l.version, createdAt: l.createdAt.toISOString(), tasks,
});

async function tasksOf(tx: Tx, vendorId: string, where: ReturnType<typeof and>) {
  const rows = await tx
    .select({ t: PT, sku: schema.productVariants.sku, barcode: schema.productVariants.barcode, binCode: schema.warehouseBins.code, binBarcode: schema.warehouseBins.barcode })
    .from(PT)
    .innerJoin(schema.productVariants, and(eq(schema.productVariants.id, PT.variantId), eq(schema.productVariants.vendorId, PT.vendorId)))
    .leftJoin(schema.warehouseBins, and(eq(schema.warehouseBins.id, PT.binId), eq(schema.warehouseBins.vendorId, PT.vendorId)))
    .where(and(eq(PT.vendorId, vendorId), where))
    .orderBy(PT.sequence, PT.createdAt, PT.id);
  return rows.map((r) => toTaskDto(r.t, r));
}

export async function getPickList(tx: Tx, vendorId: string, id: string) {
  const [l] = await tx.select().from(PL).where(and(eq(PL.id, id), eq(PL.vendorId, vendorId)));
  if (!l) throw Errors.notFound('Pick list', id);
  return toPickListDto(l, await tasksOf(tx, vendorId, eq(PT.pickListId, id)));
}

export async function listPickLists(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; status?: string; warehouseId?: string; assignedTo?: string; allowedWarehouses?: string[] | null }) {
  const ks = keyset<PickListRow>({ sorts: { createdAt: { column: PL.createdAt, kind: 'timestamp' } }, idColumn: PL.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(PL).where(and(eq(PL.vendorId, vendorId), q.status ? eq(PL.status, q.status) : undefined, q.warehouseId ? eq(PL.warehouseId, q.warehouseId) : undefined, q.assignedTo ? eq(PL.assignedTo, q.assignedTo) : undefined,
    q.allowedWarehouses ? (q.allowedWarehouses.length ? inArray(PL.warehouseId, q.allowedWarehouses) : sql`false`) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
  return { items: page.items.map((l) => toPickListDto(l)), nextCursor: page.nextCursor };
}

export async function listPickTasks(tx: Tx, vendorId: string, q: { pickListId?: string; fulfillmentId?: string; status?: string }) {
  return tasksOf(tx, vendorId, and(q.pickListId ? eq(PT.pickListId, q.pickListId) : undefined, q.fulfillmentId ? eq(PT.fulfillmentId, q.fulfillmentId) : undefined, q.status ? eq(PT.status, q.status) : undefined)!);
}

/**
 * Build one pick list for one or more CONFIRMED fulfillments of the SAME warehouse (wave/batch picking). Tasks follow the bins
 * the stock sits in (fullest bin first, then walking order by bin code); stock that is not binned yet gets a task without a bin.
 */
export async function createPickList(tx: Tx, ctx: OpCtx, w: Work, input: { fulfillmentIds: string[]; assignedTo?: string | null }): Promise<ReturnType<typeof toPickListDto>> {
  const ids = [...new Set(input.fulfillmentIds)];
  const fs: Awaited<ReturnType<typeof getFulfillment>>[] = [];
  for (const id of [...ids].sort()) fs.push(await getFulfillment(tx, ctx.vendorId, id, true)); // locked (in a fixed order): a fulfillment can only be on ONE pick list
  const wh = new Set(fs.map((f) => f.warehouseId));
  if (wh.size !== 1) throw new AppError('BAD_REQUEST', 'A pick list covers a single warehouse', { details: { warehouses: [...wh] } });
  const bad = fs.filter((f) => f.status !== 'confirmed');
  if (bad.length) throw new AppError('INVALID_STATE', 'Only confirmed fulfillments can be put on a pick list', { details: { fulfillments: bad.map((f) => ({ id: f.id, status: f.status })) } });
  const warehouseId = fs[0]!.warehouseId;
  const number = await numberFor(tx, ctx.vendorId, 'pick_list');
  const [list] = await tx.insert(PL).values({ vendorId: ctx.vendorId, number, warehouseId, assignedTo: input.assignedTo ?? null }).returning();
  const draft: Array<{ f: string; item: string; variantId: string; binId: string | null; quantity: number; code: string }> = [];
  for (const f of fs) {
    for (const it of await itemsOf(tx, ctx.vendorId, f.id)) {
      for (const s of await suggestBins(tx, ctx.vendorId, it.variantId, warehouseId, it.quantity - it.pickedQuantity - it.shortQuantity)) {
        const code = s.binId ? ((await tx.select({ c: schema.warehouseBins.code }).from(schema.warehouseBins).where(eq(schema.warehouseBins.id, s.binId)))[0]?.c ?? '') : ''; // unbinned: sorted last below
        draft.push({ f: f.id, item: it.id, variantId: it.variantId, binId: s.binId, quantity: s.quantity, code });
      }
    }
  }
  draft.sort((a, b) => Number(a.binId === null) - Number(b.binId === null) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)); // walking order by bin code, unbinned stock last
  if (draft.length) await tx.insert(PT).values(draft.map((d, i) => ({ vendorId: ctx.vendorId, pickListId: list!.id, fulfillmentId: d.f, fulfillmentItemId: d.item, variantId: d.variantId, binId: d.binId, sequence: i + 1, quantity: d.quantity })));
  for (const f of fs) await moveFulfillment(tx, ctx, w, f.id, 'picking', { note: `pick list ${number}` });
  const fx = effects(tx, ctx);
  await fx.audit({ action: 'pick_list.created', resourceType: 'pick_list', resourceId: list!.id, after: { number, warehouseId, fulfillments: ids.length, tasks: draft.length } });
  return getPickList(tx, ctx.vendorId, list!.id);
}

export async function assignPickList(tx: Tx, ctx: OpCtx, id: string, userId: string | null) {
  const l = await getPickList(tx, ctx.vendorId, id);
  if (l.status === 'completed' || l.status === 'cancelled') throw new AppError('INVALID_STATE', `This pick list is ${l.status}`, { details: { status: l.status } });
  await tx.update(PL).set({ assignedTo: userId, version: sql`${PL.version} + 1` }).where(eq(PL.id, id));
  await effects(tx, ctx).audit({ action: 'pick_list.assigned', resourceType: 'pick_list', resourceId: id, before: { assignedTo: l.assignedTo }, after: { assignedTo: userId } });
  return getPickList(tx, ctx.vendorId, id);
}

async function loadTask(tx: Tx, vendorId: string, id: string): Promise<{ t: PickTaskRow; sku: string; barcode: string | null; binBarcode: string | null; warehouseId: string }> {
  const [r] = await tx
    .select({ t: PT, sku: schema.productVariants.sku, barcode: schema.productVariants.barcode, binBarcode: schema.warehouseBins.barcode, warehouseId: PL.warehouseId })
    .from(PT).innerJoin(PL, and(eq(PL.id, PT.pickListId), eq(PL.vendorId, PT.vendorId)))
    .innerJoin(schema.productVariants, and(eq(schema.productVariants.id, PT.variantId), eq(schema.productVariants.vendorId, PT.vendorId)))
    .leftJoin(schema.warehouseBins, and(eq(schema.warehouseBins.id, PT.binId), eq(schema.warehouseBins.vendorId, PT.vendorId)))
    .where(and(eq(PT.id, id), eq(PT.vendorId, vendorId)));
  if (!r) throw Errors.notFound('Pick task', id);
  return r;
}
export const taskWarehouse = async (tx: Tx, vendorId: string, id: string): Promise<string> => (await loadTask(tx, vendorId, id)).warehouseId;

const OPEN_TASK = ['pending', 'partial', 'exception'];
function assertOpen(t: PickTaskRow): void {
  if (!OPEN_TASK.includes(t.status)) throw new AppError('INVALID_STATE', `This pick task is ${t.status}`, { details: { status: t.status } });
}

/** Scan the item (and optionally the bin) at the shelf. A wrong item is refused and recorded as a `wrong_item` exception. */
export async function scanTask(tx: Tx, ctx: OpCtx, id: string, input: { itemBarcode: string; binBarcode?: string | null }): Promise<ReturnType<typeof toTaskDto>> {
  const x = await loadTask(tx, ctx.vendorId, id);
  assertOpen(x.t);
  if (!barcodeMatches(input.itemBarcode, { barcode: x.barcode, sku: x.sku })) {
    throw new AppError('BAD_REQUEST', `Scanned code does not match ${x.sku}`, { details: { rule: 'wrong_item', expectedSku: x.sku, scanned: input.itemBarcode } });
  }
  if (input.binBarcode && x.t.binId && x.binBarcode && input.binBarcode.trim().toUpperCase() !== x.binBarcode.trim().toUpperCase()) {
    throw new AppError('BAD_REQUEST', 'Scanned bin is not the bin this task points to', { details: { rule: 'wrong_bin' } });
  }
  await tx.update(PT).set({ verified: true }).where(eq(PT.id, id));
  const [t] = await tasksOf(tx, ctx.vendorId, eq(PT.id, id));
  return t!;
}

/** Report a wrong / damaged item at the shelf: the task is flagged, a `wrong_item` or `damaged` exception is opened. */
export async function flagTask(tx: Tx, ctx: OpCtx, id: string, input: { kind: 'wrong_item' | 'damaged' | 'other'; note?: string | null }) {
  const x = await loadTask(tx, ctx.vendorId, id);
  assertOpen(x.t);
  await tx.update(PT).set({ status: 'exception', notes: input.note ?? x.t.notes }).where(eq(PT.id, id));
  const ex = await raiseException(tx, ctx, x.t.fulfillmentId, input.kind, { sku: x.sku, binId: x.t.binId, note: input.note ?? null }, id);
  return ex;
}

/**
 * Record units picked. The item must have been verified by a scan (in this call or before) unless `override` is set (manual
 * pick: audited). Picking takes the units out of their bin; the stock stays "on hand" (and reserved) until dispatch.
 */
export async function pickTask(tx: Tx, ctx: OpCtx, w: Work, id: string, input: { quantity: number; itemBarcode?: string | null; override?: boolean; note?: string | null }) {
  const x = await loadTask(tx, ctx.vendorId, id);
  const t = x.t;
  assertOpen(t);
  if (input.itemBarcode) {
    if (!barcodeMatches(input.itemBarcode, { barcode: x.barcode, sku: x.sku })) throw new AppError('BAD_REQUEST', `Scanned code does not match ${x.sku}`, { details: { rule: 'wrong_item', expectedSku: x.sku } });
  } else if (!t.verified && !input.override) {
    throw new AppError('CONFLICT', 'Scan the item before picking (or pick with override)', { details: { rule: 'scan_required', sku: x.sku } });
  }
  if (t.pickedQuantity + input.quantity > t.quantity) throw new AppError('BAD_REQUEST', 'More units than the task asks for', { details: { wanted: t.quantity, alreadyPicked: t.pickedQuantity, requested: input.quantity } });
  const f = await getFulfillment(tx, ctx.vendorId, t.fulfillmentId);
  if (f.status !== 'picking') throw new AppError('INVALID_STATE', `The fulfillment is ${f.status}; it cannot be picked now`, { details: { status: f.status } });
  if (t.binId) await removeFromBin(tx, { vendorId: ctx.vendorId, variantId: t.variantId, warehouseId: f.warehouseId, binId: t.binId, quantity: input.quantity });
  const picked = t.pickedQuantity + input.quantity;
  await tx.update(PT).set({ pickedQuantity: picked, status: picked === t.quantity ? 'picked' : 'partial', verified: true, pickedBy: ctx.actor.id && /^[0-9a-f-]{36}$/i.test(ctx.actor.id) ? ctx.actor.id : null, pickedAt: new Date(), notes: input.note ?? t.notes }).where(eq(PT.id, id));
  await tx.update(FI).set({ pickedQuantity: sql`${FI.pickedQuantity} + ${input.quantity}` }).where(eq(FI.id, t.fulfillmentItemId));
  await tx.update(PL).set({ status: 'in_progress', startedAt: sql`coalesce(${PL.startedAt}, now())` }).where(and(eq(PL.id, t.pickListId), eq(PL.status, 'open')));
  if (input.override && !input.itemBarcode) await effects(tx, ctx).audit({ action: 'pick_task.override', resourceType: 'pick_task', resourceId: id, metadata: { quantity: input.quantity, sku: x.sku } });
  await finishPickingIfDone(tx, ctx, w, f.id);
  const [out] = await tasksOf(tx, ctx.vendorId, eq(PT.id, id));
  return out!;
}

/**
 * Accept that the remaining units of a task cannot be found. The shortage is real: the missing units leave the books
 * (stock adjustment, reasoned), the reservation for them is released, the order line is flagged short and a `pick_short`
 * exception is opened. If nothing at all could be picked for the fulfillment, it is cancelled.
 */
export async function shortPick(tx: Tx, ctx: OpCtx, w: Work, id: string, input: { reason?: string | null }) {
  const x = await loadTask(tx, ctx.vendorId, id);
  const t = x.t;
  assertOpen(t);
  const missing = t.quantity - t.pickedQuantity;
  const f = await getFulfillment(tx, ctx.vendorId, t.fulfillmentId);
  if (f.status !== 'picking') throw new AppError('INVALID_STATE', `The fulfillment is ${f.status}; it cannot be picked now`, { details: { status: f.status } });
  const [fi] = await tx.select().from(FI).where(eq(FI.id, t.fulfillmentItemId));
  const reason = input.reason ?? 'not found at pick';
  // the units that are not there are not in the bin either: the bin count shrinks with the stock (sum of bins <= on hand)
  if (t.binId) {
    const held = (await binStockOf(tx, ctx.vendorId, { binId: t.binId, variantId: t.variantId })).reduce((n, b) => n + b.quantity, 0);
    const take = Math.min(missing, held);
    if (take > 0) await removeFromBin(tx, { vendorId: ctx.vendorId, variantId: t.variantId, warehouseId: f.warehouseId, binId: t.binId, quantity: take });
  }
  await tx.update(PT).set({ status: 'short', notes: reason }).where(eq(PT.id, id));
  await tx.update(FI).set({ shortQuantity: sql`${FI.shortQuantity} + ${missing}` }).where(eq(FI.id, t.fulfillmentItemId));
  await releaseReservedUnits(tx, { vendorId: ctx.vendorId, orderId: f.orderId, orderItemId: fi!.orderItemId, warehouseId: f.warehouseId, quantity: missing, reason: `short pick: ${reason}`, actor: ctx.actor });
  await adjustStock(tx, { vendorId: ctx.vendorId, variantId: t.variantId, warehouseId: f.warehouseId, delta: -missing, reason: `short pick on ${f.number}: ${reason}`, referenceType: 'adjustment', referenceId: f.id, actor: ctx.actor });
  await recordShortage(tx, ctx, fi!.orderItemId, missing, reason);
  const ex = await raiseException(tx, ctx, f.id, 'pick_short', { sku: x.sku, missing, binId: t.binId, reason }, id);
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`coalesce(sum(${FI.pickedQuantity}), 0)::int` }).from(FI).where(and(eq(FI.vendorId, ctx.vendorId), eq(FI.fulfillmentId, f.id)));
  const items = await itemsOf(tx, ctx.vendorId, f.id);
  if (items.every((i) => i.pickedQuantity + i.shortQuantity >= i.quantity) && n === 0) await cancelFulfillment(tx, ctx, w, f.id, 'nothing could be picked');
  else await finishPickingIfDone(tx, ctx, w, f.id);
  const [out] = await tasksOf(tx, ctx.vendorId, eq(PT.id, id));
  return { task: out!, exception: ex };
}

/** when every unit of a fulfillment is picked or accepted as short, it moves to `picked`; finished pick lists complete */
export async function finishPickingIfDone(tx: Tx, ctx: OpCtx, w: Work, fulfillmentId: string): Promise<void> {
  const f = await getFulfillment(tx, ctx.vendorId, fulfillmentId);
  if (f.status === 'picking') {
    const items = await itemsOf(tx, ctx.vendorId, fulfillmentId);
    if (items.every((i) => i.pickedQuantity + i.shortQuantity >= i.quantity)) await moveFulfillment(tx, ctx, w, fulfillmentId, 'picked');
  }
  await closeFinishedPickLists(tx, ctx.vendorId);
}

export { F };
