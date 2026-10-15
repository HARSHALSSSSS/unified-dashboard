import { and, eq, inArray, isNull, keyset, schema, sql, writeOutboxEvent, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { addToBin } from './bins';
import { applyMovement, assertStockTargets, nextCounter } from './ledger';

const IS = schema.inboundShipments;
const II = schema.inboundShipmentItems;
type Actor = { type: 'user' | 'api_key' | 'system' | 'webhook'; id?: string | null };

export type InboundRow = typeof IS.$inferSelect;

/**
 * Inbound stock: goods expected from a supplier (or another site) are `incoming` until they are received. Receiving moves
 * units incoming -> on hand (good) or incoming -> damaged; both through the ledger. Closing a short shipment clears whatever
 * will never arrive so `incoming` cannot drift.
 */
export async function createInbound(tx: Tx, vendorId: string, actor: Actor, input: { warehouseId: string; supplier?: string | null; reference?: string | null; expectedAt?: Date | null; notes?: string | null; items: Array<{ variantId: string; expectedQuantity: number }> }) {
  if (new Set(input.items.map((i) => i.variantId)).size !== input.items.length) throw new AppError('BAD_REQUEST', 'Each variant may appear once per inbound shipment');
  const [wh] = await tx.select({ id: schema.warehouses.id, status: schema.warehouses.status }).from(schema.warehouses).where(and(eq(schema.warehouses.id, input.warehouseId), eq(schema.warehouses.vendorId, vendorId), isNull(schema.warehouses.deletedAt)));
  if (!wh) throw Errors.notFound('Warehouse', input.warehouseId);
  if (wh.status !== 'active') throw new AppError('CONFLICT', 'The warehouse is not active', { details: { rule: 'warehouse_inactive' } });
  const found = await tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.vendorId, vendorId), inArray(schema.productVariants.id, input.items.map((i) => i.variantId))));
  if (found.length !== input.items.length) throw Errors.notFound('Variant');
  const number = `IN-${String(await nextCounter(tx, vendorId, 'inbound_shipment')).padStart(6, '0')}`;
  const [row] = await tx.insert(IS).values({ vendorId, number, warehouseId: input.warehouseId, supplier: input.supplier ?? null, reference: input.reference ?? null, expectedAt: input.expectedAt ?? null, notes: input.notes ?? null, status: 'expected' }).returning();
  await tx.insert(II).values(input.items.map((i) => ({ vendorId, inboundId: row!.id, variantId: i.variantId, expectedQuantity: i.expectedQuantity })));
  for (const i of input.items) {
    await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: input.warehouseId, type: 'incoming_add', incoming: i.expectedQuantity, referenceType: 'import', referenceId: row!.id, reason: `inbound ${number} expected`, idempotencyKey: `inbound-expect:${row!.id}:${i.variantId}`, actor });
  }
  await writeOutboxEvent(tx, { type: 'inbound.created', vendorId, aggregateType: 'inbound_shipment', aggregateId: row!.id, payload: { number, warehouseId: input.warehouseId, items: input.items.length } });
  return loadInbound(tx, vendorId, row!.id);
}

export async function loadInbound(tx: Tx, vendorId: string, id: string) {
  const [s] = await tx.select().from(IS).where(and(eq(IS.id, id), eq(IS.vendorId, vendorId)));
  if (!s) throw Errors.notFound('Inbound shipment', id);
  const items = await tx.select({ i: II, sku: schema.productVariants.sku }).from(II).innerJoin(schema.productVariants, and(eq(schema.productVariants.id, II.variantId), eq(schema.productVariants.vendorId, II.vendorId))).where(and(eq(II.vendorId, vendorId), eq(II.inboundId, id)));
  return { s, items };
}

export const toInboundDto = (x: Awaited<ReturnType<typeof loadInbound>>) => ({
  id: x.s.id, number: x.s.number, warehouseId: x.s.warehouseId, supplier: x.s.supplier, reference: x.s.reference, status: x.s.status as (typeof schema.INBOUND_STATUSES)[number], notes: x.s.notes,
  expectedAt: x.s.expectedAt ? x.s.expectedAt.toISOString() : null, receivedAt: x.s.receivedAt ? x.s.receivedAt.toISOString() : null, version: x.s.version, createdAt: x.s.createdAt.toISOString(),
  items: x.items.map((r) => ({ variantId: r.i.variantId, sku: r.sku, expectedQuantity: r.i.expectedQuantity, receivedQuantity: r.i.receivedQuantity, damagedQuantity: r.i.damagedQuantity, outstandingQuantity: Math.max(0, r.i.expectedQuantity - r.i.receivedQuantity), binId: r.i.binId })),
});

/**
 * Receive goods. `receivedQuantity` is what physically arrived NOW (good + damaged); `damagedQuantity` is the damaged part of it.
 * Receiving more than expected is allowed (the extra is plain stock, nothing was `incoming` for it) and flagged in the result.
 */
/** serialise changes to one inbound shipment (two operators receiving at once must not overwrite each other) */
async function lockInbound(tx: Tx, vendorId: string, id: string): Promise<void> {
  await tx.select({ id: IS.id }).from(IS).where(and(eq(IS.id, id), eq(IS.vendorId, vendorId))).for('update');
}

export async function receiveInbound(tx: Tx, vendorId: string, actor: Actor, id: string, lines: Array<{ variantId: string; receivedQuantity: number; damagedQuantity?: number; binId?: string | null }>) {
  await lockInbound(tx, vendorId, id);
  const { s, items } = await loadInbound(tx, vendorId, id);
  if (!['expected', 'receiving'].includes(s.status)) throw new AppError('INVALID_STATE', `A ${s.status} inbound shipment cannot receive goods`, { details: { status: s.status } });
  const byVariant = new Map(items.map((x) => [x.i.variantId, x.i]));
  const over: Array<{ variantId: string; extra: number }> = [];
  for (const l of lines) {
    const item = byVariant.get(l.variantId);
    if (!item) throw new AppError('BAD_REQUEST', 'That variant is not part of this inbound shipment', { details: { variantId: l.variantId } });
    const damaged = l.damagedQuantity ?? 0;
    if (damaged > l.receivedQuantity) throw new AppError('BAD_REQUEST', 'damagedQuantity cannot exceed receivedQuantity', { details: { variantId: l.variantId } });
    const good = l.receivedQuantity - damaged;
    // units that were expected come out of `incoming`; extras were never incoming
    const outstanding = Math.max(0, item.expectedQuantity - item.receivedQuantity);
    const fromIncoming = Math.min(l.receivedQuantity, outstanding);
    if (l.receivedQuantity > outstanding) over.push({ variantId: l.variantId, extra: l.receivedQuantity - outstanding });
    await assertStockTargets(tx, vendorId, l.variantId, s.warehouseId);
    await applyMovement(tx, {
      vendorId, variantId: l.variantId, warehouseId: s.warehouseId, type: 'incoming_receive', incoming: -fromIncoming, onHand: good, damaged,
      referenceType: 'import', referenceId: s.id, reason: `inbound ${s.number} received`, idempotencyKey: `inbound-recv:${s.id}:${l.variantId}:${item.receivedQuantity}`, actor,
    });
    if (l.binId && good > 0) await addToBin(tx, { vendorId, variantId: l.variantId, warehouseId: s.warehouseId, binId: l.binId, quantity: good });
    await tx.update(II).set({ receivedQuantity: item.receivedQuantity + l.receivedQuantity, damagedQuantity: item.damagedQuantity + damaged, binId: l.binId ?? item.binId }).where(eq(II.id, item.id));
    byVariant.set(l.variantId, { ...item, receivedQuantity: item.receivedQuantity + l.receivedQuantity, damagedQuantity: item.damagedQuantity + damaged });
  }
  const complete = [...byVariant.values()].every((i) => i.receivedQuantity >= i.expectedQuantity);
  await tx.update(IS).set({ status: complete ? 'received' : 'receiving', receivedAt: complete ? new Date() : s.receivedAt, version: sql`${IS.version} + 1` }).where(eq(IS.id, id));
  if (complete) await writeOutboxEvent(tx, { type: 'inbound.received', vendorId, aggregateType: 'inbound_shipment', aggregateId: id, payload: { number: s.number, warehouseId: s.warehouseId } });
  return { inbound: await loadInbound(tx, vendorId, id), overReceived: over };
}

/** Close a partly received shipment: whatever never arrived is removed from `incoming`. */
export async function closeInbound(tx: Tx, vendorId: string, actor: Actor, id: string) {
  await lockInbound(tx, vendorId, id);
  const { s, items } = await loadInbound(tx, vendorId, id);
  if (!['expected', 'receiving'].includes(s.status)) throw new AppError('INVALID_STATE', `A ${s.status} inbound shipment cannot be closed`, { details: { status: s.status } });
  for (const { i } of items) {
    const outstanding = Math.max(0, i.expectedQuantity - i.receivedQuantity);
    if (outstanding > 0) await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: s.warehouseId, type: 'incoming_add', incoming: -outstanding, referenceType: 'import', referenceId: s.id, reason: `inbound ${s.number} closed short`, idempotencyKey: `inbound-close:${s.id}:${i.variantId}`, actor });
  }
  await tx.update(IS).set({ status: 'closed', version: sql`${IS.version} + 1` }).where(eq(IS.id, id));
  return loadInbound(tx, vendorId, id);
}

export async function cancelInbound(tx: Tx, vendorId: string, actor: Actor, id: string) {
  await lockInbound(tx, vendorId, id);
  const { s, items } = await loadInbound(tx, vendorId, id);
  if (s.status !== 'expected') throw new AppError('INVALID_STATE', 'Only an inbound shipment with nothing received can be cancelled (close it instead)', { details: { status: s.status } });
  for (const { i } of items) await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: s.warehouseId, type: 'incoming_add', incoming: -i.expectedQuantity, referenceType: 'import', referenceId: s.id, reason: `inbound ${s.number} cancelled`, idempotencyKey: `inbound-cancel:${s.id}:${i.variantId}`, actor });
  await tx.update(IS).set({ status: 'cancelled', version: sql`${IS.version} + 1` }).where(eq(IS.id, id));
  return loadInbound(tx, vendorId, id);
}

export async function listInbound(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; status?: string; warehouseId?: string }) {
  const ks = keyset<InboundRow>({ sorts: { createdAt: { column: IS.createdAt, kind: 'timestamp' } }, idColumn: IS.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(IS).where(and(eq(IS.vendorId, vendorId), q.status ? eq(IS.status, q.status) : undefined, q.warehouseId ? eq(IS.warehouseId, q.warehouseId) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
  return { items: await Promise.all(page.items.map(async (s) => toInboundDto(await loadInbound(tx, vendorId, s.id)))), nextCursor: page.nextCursor };
}
