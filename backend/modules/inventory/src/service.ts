import { and, desc, eq, ilike, inArray, isNull, keyset, or, schema, sql, escapeLike, type Tx } from '@oms/database';
import { AppError, Errors, newId } from '@oms/shared';
import { allocationOrder } from '@oms/mod-warehouses';
import { applyMovement, assertStockTargets, availableOf, nextCounter, type MovementResult, type StockRow } from './ledger';

const I = schema.inventory;
const M = schema.inventoryMovements;
const R = schema.inventoryReservations;
const V = schema.productVariants;
const P = schema.products;
const W = schema.warehouses;

type Actor = { type: 'user' | 'api_key' | 'system' | 'webhook'; id?: string | null };

// ------------------------------------------------------------------------------------------------
// reads
// ------------------------------------------------------------------------------------------------
export const toStockDto = (s: StockRow, extra: { sku: string; title: string; warehouseCode: string }) => ({
  id: s.id, variantId: s.variantId, sku: extra.sku, productTitle: extra.title, warehouseId: s.warehouseId, warehouseCode: extra.warehouseCode,
  onHand: s.quantityOnHand, reserved: s.quantityReserved, available: availableOf(s), incoming: s.quantityIncoming, damaged: s.quantityDamaged, returned: s.quantityReturned,
  reorderLevel: s.reorderLevel, version: s.version, updatedAt: s.updatedAt.toISOString(),
});

export interface StockListInput { limit: number; cursor?: string; sort?: Array<{ field: string; direction: 'asc' | 'desc' }>; variantId?: string; warehouseId?: string; q?: string; lowStock?: boolean; outOfStock?: boolean }

export async function listStock(tx: Tx, vendorId: string, input: StockListInput) {
  type Row = { s: StockRow; sku: string; title: string; code: string };
  const ks = keyset<Row>({
    sorts: { updatedAt: { column: I.updatedAt, kind: 'timestamp' }, sku: { column: V.sku, kind: 'text' } },
    idColumn: I.id, sort: input.sort, defaultSort: { field: 'updatedAt', direction: 'desc' }, cursor: input.cursor, limit: input.limit,
  });
  const field = input.sort?.[0]?.field ?? 'updatedAt';
  const search = input.q ? or(ilike(V.sku, `%${escapeLike(input.q)}%`), ilike(P.title, `%${escapeLike(input.q)}%`)) : undefined;
  const rows = await tx
    .select({ s: I, sku: V.sku, title: P.title, code: W.code })
    .from(I)
    .innerJoin(V, and(eq(V.id, I.variantId), eq(V.vendorId, I.vendorId)))
    .innerJoin(P, and(eq(P.id, V.productId), eq(P.vendorId, V.vendorId)))
    .innerJoin(W, and(eq(W.id, I.warehouseId), eq(W.vendorId, I.vendorId)))
    .where(and(
      eq(I.vendorId, vendorId), input.variantId ? eq(I.variantId, input.variantId) : undefined, input.warehouseId ? eq(I.warehouseId, input.warehouseId) : undefined, search,
      input.lowStock ? sql`${I.reorderLevel} IS NOT NULL AND ${I.quantityOnHand} - ${I.quantityReserved} <= ${I.reorderLevel}` : undefined,
      input.outOfStock ? sql`${I.quantityOnHand} - ${I.quantityReserved} <= 0` : undefined, ks.where,
    ))
    .orderBy(...ks.orderBy)
    .limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: field === 'sku' ? r.sku : r.s.updatedAt, id: r.s.id }));
  return { items: page.items.map((r) => toStockDto(r.s, { sku: r.sku, title: r.title, warehouseCode: r.code })), nextCursor: page.nextCursor };
}

export interface Availability { onHand: number; reserved: number; available: number; incoming: number; damaged: number; returned: number }
const EMPTY: Availability = { onHand: 0, reserved: 0, available: 0, incoming: 0, damaged: 0, returned: 0 };

/** Sellable stock per variant across ACTIVE warehouses (optionally limited to the warehouses feeding one channel). */
export async function availabilityFor(tx: Tx, vendorId: string, variantIds: string[], warehouseIds?: string[]): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>(variantIds.map((id) => [id, { ...EMPTY }]));
  if (variantIds.length === 0) return out;
  const rows = await tx
    .select({
      variantId: I.variantId, onHand: sql<number>`sum(${I.quantityOnHand})::int`, reserved: sql<number>`sum(${I.quantityReserved})::int`, incoming: sql<number>`sum(${I.quantityIncoming})::int`,
      damaged: sql<number>`sum(${I.quantityDamaged})::int`, returned: sql<number>`sum(${I.quantityReturned})::int`,
    })
    .from(I)
    .innerJoin(W, and(eq(W.id, I.warehouseId), eq(W.vendorId, I.vendorId)))
    .where(and(eq(I.vendorId, vendorId), inArray(I.variantId, variantIds), eq(W.status, 'active'), isNull(W.deletedAt), warehouseIds?.length ? inArray(I.warehouseId, warehouseIds) : undefined))
    .groupBy(I.variantId);
  for (const r of rows) out.set(r.variantId, { onHand: r.onHand, reserved: r.reserved, available: r.onHand - r.reserved, incoming: r.incoming, damaged: r.damaged, returned: r.returned });
  return out;
}

export async function variantOverview(tx: Tx, vendorId: string, variantId: string) {
  const [v] = await tx.select({ id: V.id, sku: V.sku, title: P.title }).from(V).innerJoin(P, and(eq(P.id, V.productId), eq(P.vendorId, V.vendorId))).where(and(eq(V.id, variantId), eq(V.vendorId, vendorId)));
  if (!v) throw Errors.notFound('Variant', variantId);
  const rows = await tx.select({ s: I, code: W.code }).from(I).innerJoin(W, and(eq(W.id, I.warehouseId), eq(W.vendorId, I.vendorId))).where(and(eq(I.vendorId, vendorId), eq(I.variantId, variantId))).orderBy(W.code);
  const totals = { ...EMPTY };
  for (const r of rows) {
    totals.onHand += r.s.quantityOnHand; totals.reserved += r.s.quantityReserved; totals.incoming += r.s.quantityIncoming; totals.damaged += r.s.quantityDamaged; totals.returned += r.s.quantityReturned;
  }
  totals.available = totals.onHand - totals.reserved;
  return { variantId: v.id, sku: v.sku, productTitle: v.title, totals, warehouses: rows.map((r) => toStockDto(r.s, { sku: v.sku, title: v.title, warehouseCode: r.code })) };
}

// ------------------------------------------------------------------------------------------------
// stock operations (all via the ledger)
// ------------------------------------------------------------------------------------------------
interface Target { vendorId: string; variantId: string; warehouseId: string; actor?: Actor; reason?: string | null; idempotencyKey?: string | null; referenceType?: 'manual' | 'order' | 'adjustment' | 'import' | 'return'; referenceId?: string | null }

export async function receiveStock(tx: Tx, t: Target & { quantity: number; fromIncoming?: boolean }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  return applyMovement(tx, { ...t, type: t.fromIncoming ? 'incoming_receive' : 'receive', onHand: t.quantity, ...(t.fromIncoming ? { incoming: -t.quantity } : {}), referenceType: t.referenceType ?? 'manual' });
}

export async function addIncoming(tx: Tx, t: Target & { quantity: number }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  return applyMovement(tx, { ...t, type: 'incoming_add', incoming: t.quantity, referenceType: t.referenceType ?? 'manual' });
}

/** delta: +/- units; setOnHand: a stock count (the ledger records the DIFFERENCE, never an overwrite) */
export async function adjustStock(tx: Tx, t: Target & { delta?: number; setOnHand?: number }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  if ((t.delta === undefined) === (t.setOnHand === undefined)) throw new AppError('BAD_REQUEST', 'Provide exactly one of delta or setOnHand');
  if (t.setOnHand !== undefined) {
    const [cur] = await tx.select().from(I).where(and(eq(I.vendorId, t.vendorId), eq(I.variantId, t.variantId), eq(I.warehouseId, t.warehouseId)));
    const diff = t.setOnHand - (cur?.quantityOnHand ?? 0);
    if (diff === 0) throw new AppError('BAD_REQUEST', 'The counted quantity equals the current quantity; nothing to adjust');
    return applyMovement(tx, { ...t, type: 'count', onHand: diff, referenceType: t.referenceType ?? 'count', reason: t.reason ?? `stock count: ${t.setOnHand}` });
  }
  if (t.delta === 0) throw new AppError('BAD_REQUEST', 'delta must not be zero');
  return applyMovement(tx, { ...t, type: 'adjust', onHand: t.delta, referenceType: t.referenceType ?? 'adjustment' });
}

export async function markDamaged(tx: Tx, t: Target & { quantity: number; restore?: boolean }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  return t.restore
    ? applyMovement(tx, { ...t, type: 'undamage', onHand: t.quantity, damaged: -t.quantity, referenceType: t.referenceType ?? 'manual' })
    : applyMovement(tx, { ...t, type: 'damage', onHand: -t.quantity, damaged: t.quantity, referenceType: t.referenceType ?? 'manual' });
}

/** A customer return arrives. hold = quarantine until inspected; restock = sellable again; damaged = write-off bucket */
export async function receiveReturn(tx: Tx, t: Target & { quantity: number; disposition: 'hold' | 'restock' | 'damaged' }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  const base = { ...t, referenceType: t.referenceType ?? ('return' as const) };
  if (t.disposition === 'hold') return applyMovement(tx, { ...base, type: 'return_in', returned: t.quantity });
  if (t.disposition === 'damaged') return applyMovement(tx, { ...base, type: 'return_in', damaged: t.quantity });
  return applyMovement(tx, { ...base, type: 'return_restock', onHand: t.quantity });
}

/** inspect held returns: move them from `returned` to sellable stock or to damaged */
export async function resolveReturned(tx: Tx, t: Target & { quantity: number; to: 'restock' | 'damaged' }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  return applyMovement(tx, { ...t, type: 'return_restock', returned: -t.quantity, ...(t.to === 'restock' ? { onHand: t.quantity } : { damaged: t.quantity }), referenceType: t.referenceType ?? 'return' });
}

export async function setReorderLevel(tx: Tx, vendorId: string, variantId: string, warehouseId: string, level: number | null): Promise<void> {
  await assertStockTargets(tx, vendorId, variantId, warehouseId);
  await tx.insert(I).values({ vendorId, variantId, warehouseId, reorderLevel: level }).onConflictDoUpdate({ target: [I.vendorId, I.variantId, I.warehouseId], set: { reorderLevel: level } });
}

// ------------------------------------------------------------------------------------------------
// reservations (orders hold stock; shipping consumes it; cancelling gives it back)
// ------------------------------------------------------------------------------------------------
export interface ReserveInput { vendorId: string; orderId: string; orderItemId: string; variantId: string; quantity: number; warehouseIds?: string[]; actor?: Actor }
export interface ReserveResult { reserved: number; short: number; allocations: Array<{ warehouseId: string; quantity: number }> }

/**
 * Holds up to `quantity` units for an order line, taking from warehouses in allocation order (default first).
 * Idempotent per order line: calling it again returns what is already held. NEVER oversells: a shortfall is reported
 * (`short`), not forced. Partial reservations are allowed (the order is flagged for attention by the caller).
 */
export async function reserveForOrderItem(tx: Tx, input: ReserveInput): Promise<ReserveResult> {
  const existing = await tx.select().from(R).where(and(eq(R.vendorId, input.vendorId), eq(R.orderItemId, input.orderItemId), eq(R.status, 'active')));
  const held = existing.reduce((n, r) => n + r.quantity, 0);
  const allocations = existing.map((r) => ({ warehouseId: r.warehouseId, quantity: r.quantity }));
  let remaining = input.quantity - held;
  if (remaining <= 0) return { reserved: held, short: 0, allocations };

  for (const w of await allocationOrder(tx, input.vendorId, input.warehouseIds)) {
    if (remaining <= 0) break;
    const [row] = await tx.select().from(I).where(and(eq(I.vendorId, input.vendorId), eq(I.variantId, input.variantId), eq(I.warehouseId, w.id)));
    const avail = row ? availableOf(row) : 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    const prior = existing.find((r) => r.warehouseId === w.id);
    let mv;
    try {
      mv = await applyMovement(tx, {
        vendorId: input.vendorId, variantId: input.variantId, warehouseId: w.id, type: 'reserve', reserved: take, referenceType: 'order', referenceId: input.orderId,
        reason: 'reserved for order', idempotencyKey: `reserve:${input.orderItemId}:${w.id}:${newId()}`, actor: input.actor,
      });
    } catch (e) {
      if (e instanceof AppError && e.code === 'INSUFFICIENT_STOCK') continue; // another order took the unit between our read and the lock: reserve what is left elsewhere
      throw e;
    }
    if (mv.duplicate) continue;
    if (prior) await tx.update(R).set({ quantity: prior.quantity + take }).where(eq(R.id, prior.id));
    else if ((await tx.select({ id: R.id }).from(R).where(and(eq(R.vendorId, input.vendorId), eq(R.orderItemId, input.orderItemId), eq(R.warehouseId, w.id))))[0]) await tx.update(R).set({ quantity: take, status: 'active', releasedAt: null, committedAt: null }).where(and(eq(R.vendorId, input.vendorId), eq(R.orderItemId, input.orderItemId), eq(R.warehouseId, w.id)));
    else await tx.insert(R).values({ vendorId: input.vendorId, orderId: input.orderId, orderItemId: input.orderItemId, variantId: input.variantId, warehouseId: w.id, quantity: take, status: 'active' });
    const a = allocations.find((x) => x.warehouseId === w.id);
    if (a) a.quantity += take; else allocations.push({ warehouseId: w.id, quantity: take });
    remaining -= take;
  }
  const reserved = input.quantity - remaining;
  return { reserved, short: Math.max(0, remaining), allocations };
}

/** give every active reservation of an order back to available stock (cancellation / failed fulfilment) */
export async function releaseOrder(tx: Tx, vendorId: string, orderId: string, reason: string, actor?: Actor): Promise<number> {
  const rows = await tx.select().from(R).where(and(eq(R.vendorId, vendorId), eq(R.orderId, orderId), eq(R.status, 'active')));
  let released = 0;
  for (const r of rows) {
    await applyMovement(tx, { vendorId, variantId: r.variantId, warehouseId: r.warehouseId, type: 'release', reserved: -r.quantity, referenceType: 'order', referenceId: orderId, reason, idempotencyKey: `release:${r.id}`, actor });
    await tx.update(R).set({ status: 'released', releasedAt: new Date() }).where(eq(R.id, r.id));
    released += r.quantity;
  }
  return released;
}

/** the goods left the warehouse: consume the reservation (on_hand and reserved drop together; sellable quantity is unchanged) */
export async function commitOrder(tx: Tx, vendorId: string, orderId: string, actor?: Actor): Promise<number> {
  const rows = await tx.select().from(R).where(and(eq(R.vendorId, vendorId), eq(R.orderId, orderId), eq(R.status, 'active')));
  let committed = 0;
  for (const r of rows) {
    await applyMovement(tx, { vendorId, variantId: r.variantId, warehouseId: r.warehouseId, type: 'commit', onHand: -r.quantity, reserved: -r.quantity, referenceType: 'order', referenceId: orderId, reason: 'dispatched', idempotencyKey: `commit:${r.id}`, actor });
    await tx.update(R).set({ status: 'committed', committedAt: new Date() }).where(eq(R.id, r.id));
    committed += r.quantity;
  }
  return committed;
}

export async function reservationsForOrder(tx: Tx, vendorId: string, orderId: string) {
  return tx.select().from(R).where(and(eq(R.vendorId, vendorId), eq(R.orderId, orderId)));
}

export async function listReservations(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; orderId?: string; variantId?: string; status?: string }) {
  const ks = keyset<typeof R.$inferSelect>({ sorts: { createdAt: { column: R.createdAt, kind: 'timestamp' } }, idColumn: R.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(R).where(and(eq(R.vendorId, vendorId), q.orderId ? eq(R.orderId, q.orderId) : undefined, q.variantId ? eq(R.variantId, q.variantId) : undefined, q.status ? eq(R.status, q.status) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  return ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
}

// ------------------------------------------------------------------------------------------------
// movements + ledger check
// ------------------------------------------------------------------------------------------------
export type MovementRow = typeof M.$inferSelect;
export const toMovementDto = (m: MovementRow) => ({
  id: m.id, variantId: m.variantId, warehouseId: m.warehouseId, type: m.type as (typeof schema.MOVEMENT_TYPES)[number],
  deltaOnHand: m.deltaOnHand, deltaReserved: m.deltaReserved, deltaIncoming: m.deltaIncoming, deltaDamaged: m.deltaDamaged, deltaReturned: m.deltaReturned,
  onHandAfter: m.onHandAfter, reservedAfter: m.reservedAfter, reason: m.reason, referenceType: m.referenceType, referenceId: m.referenceId, actorType: m.actorType, actorId: m.actorId, createdAt: m.createdAt.toISOString(),
});

export async function listMovements(tx: Tx, vendorId: string, q: { limit: number; before?: number; variantId?: string; warehouseId?: string; type?: string; referenceType?: string; referenceId?: string }) {
  const rows = await tx
    .select()
    .from(M)
    .where(and(eq(M.vendorId, vendorId), q.before ? sql`${M.id} < ${q.before}` : undefined, q.variantId ? eq(M.variantId, q.variantId) : undefined, q.warehouseId ? eq(M.warehouseId, q.warehouseId) : undefined, q.type ? eq(M.type, q.type) : undefined, q.referenceType ? eq(M.referenceType, q.referenceType) : undefined, q.referenceId ? eq(M.referenceId, q.referenceId) : undefined))
    .orderBy(desc(M.id))
    .limit(q.limit + 1);
  const hasMore = rows.length > q.limit;
  const items = hasMore ? rows.slice(0, q.limit) : rows;
  return { items, nextBefore: hasMore ? items[items.length - 1]!.id : null };
}

/** empty = the stock cache equals the movement ledger for every (variant, warehouse) */
export async function ledgerDrift(tx: Tx, vendorId: string) {
  const res = await tx.execute<Record<string, unknown>>(sql`select * from inventory_ledger_drift(${vendorId}::uuid)`);
  return res.rows.map((r) => ({
    variantId: String(r.variant_id), warehouseId: String(r.warehouse_id),
    onHand: Number(r.on_hand), ledgerOnHand: Number(r.ledger_on_hand), reserved: Number(r.reserved), ledgerReserved: Number(r.ledger_reserved),
    incoming: Number(r.incoming), ledgerIncoming: Number(r.ledger_incoming), damaged: Number(r.damaged), ledgerDamaged: Number(r.ledger_damaged), returned: Number(r.returned), ledgerReturned: Number(r.ledger_returned),
  }));
}

// ------------------------------------------------------------------------------------------------
// transfers: draft -> in_transit (leaves the source, shows as incoming at the destination) -> received
// ------------------------------------------------------------------------------------------------
const T = schema.stockTransfers;
const TI = schema.stockTransferItems;
export type TransferRow = typeof T.$inferSelect;

export async function loadTransfer(tx: Tx, vendorId: string, id: string, lock = false) {
  const q = tx.select().from(T).where(and(eq(T.id, id), eq(T.vendorId, vendorId)));
  const [t] = await (lock ? q.for('update') : q);
  if (!t) throw Errors.notFound('Stock transfer', id);
  const items = await tx.select({ i: TI, sku: V.sku }).from(TI).innerJoin(V, and(eq(V.id, TI.variantId), eq(V.vendorId, TI.vendorId))).where(and(eq(TI.vendorId, vendorId), eq(TI.transferId, id)));
  return { t, items };
}

export const toTransferDto = (x: Awaited<ReturnType<typeof loadTransfer>>) => ({
  id: x.t.id, number: x.t.number, fromWarehouseId: x.t.fromWarehouseId, toWarehouseId: x.t.toWarehouseId, status: x.t.status as (typeof schema.TRANSFER_STATUSES)[number], notes: x.t.notes,
  shippedAt: x.t.shippedAt ? x.t.shippedAt.toISOString() : null, receivedAt: x.t.receivedAt ? x.t.receivedAt.toISOString() : null, version: x.t.version, createdAt: x.t.createdAt.toISOString(),
  items: x.items.map((r) => ({ variantId: r.i.variantId, sku: r.sku, quantity: r.i.quantity, receivedQuantity: r.i.receivedQuantity })),
});

export async function createTransfer(tx: Tx, vendorId: string, input: { fromWarehouseId: string; toWarehouseId: string; items: Array<{ variantId: string; quantity: number }>; notes?: string | null }) {
  if (input.fromWarehouseId === input.toWarehouseId) throw new AppError('BAD_REQUEST', 'Source and destination must differ');
  if (new Set(input.items.map((i) => i.variantId)).size !== input.items.length) throw new AppError('BAD_REQUEST', 'Each variant may appear once per transfer');
  for (const wid of [input.fromWarehouseId, input.toWarehouseId]) {
    const [w] = await tx.select({ id: W.id, status: W.status }).from(W).where(and(eq(W.id, wid), eq(W.vendorId, vendorId), isNull(W.deletedAt)));
    if (!w) throw Errors.notFound('Warehouse', wid);
    if (w.status !== 'active') throw new AppError('CONFLICT', 'Both warehouses must be active', { details: { warehouseId: wid } });
  }
  const found = await tx.select({ id: V.id }).from(V).where(and(eq(V.vendorId, vendorId), inArray(V.id, input.items.map((i) => i.variantId))));
  if (found.length !== input.items.length) throw Errors.notFound('Variant');
  const number = `TR-${String(await nextCounter(tx, vendorId, 'stock_transfer')).padStart(6, '0')}`;
  const [t] = await tx.insert(T).values({ vendorId, number, fromWarehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId, notes: input.notes ?? null }).returning();
  await tx.insert(TI).values(input.items.map((i) => ({ vendorId, transferId: t!.id, variantId: i.variantId, quantity: i.quantity })));
  return loadTransfer(tx, vendorId, t!.id);
}

/** stock leaves the source warehouse now; the destination sees it as incoming until it is received */
export async function shipTransfer(tx: Tx, vendorId: string, id: string, actor?: Actor) {
  const { t, items } = await loadTransfer(tx, vendorId, id, true);
  if (t.status !== 'draft') throw new AppError('INVALID_STATE', `A ${t.status} transfer cannot be shipped`, { details: { status: t.status } });
  for (const { i } of items) {
    await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: t.fromWarehouseId, type: 'transfer_out', onHand: -i.quantity, referenceType: 'transfer', referenceId: t.id, reason: `transfer ${t.number} out`, idempotencyKey: `transfer-out:${t.id}:${i.variantId}`, actor });
    await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: t.toWarehouseId, type: 'incoming_add', incoming: i.quantity, referenceType: 'transfer', referenceId: t.id, reason: `transfer ${t.number} in transit`, idempotencyKey: `transfer-incoming:${t.id}:${i.variantId}`, actor });
  }
  await tx.update(T).set({ status: 'in_transit', shippedAt: new Date(), version: sql`${T.version} + 1` }).where(eq(T.id, id));
  return loadTransfer(tx, vendorId, id);
}

/** receive the shipped quantities (default: everything). Anything not received is written back to the source. */
export async function receiveTransfer(tx: Tx, vendorId: string, id: string, received?: Array<{ variantId: string; quantity: number }>, actor?: Actor) {
  const { t, items } = await loadTransfer(tx, vendorId, id, true);
  if (t.status !== 'in_transit') throw new AppError('INVALID_STATE', `A ${t.status} transfer cannot be received`, { details: { status: t.status } });
  const byVariant = new Map(received?.map((r) => [r.variantId, r.quantity]));
  for (const { i } of items) {
    const qty = received ? byVariant.get(i.variantId) ?? 0 : i.quantity;
    if (qty < 0 || qty > i.quantity) throw new AppError('BAD_REQUEST', 'Received quantity must be between 0 and the shipped quantity', { details: { variantId: i.variantId, shipped: i.quantity } });
    if (qty > 0) {
      await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: t.toWarehouseId, type: 'incoming_receive', incoming: -qty, onHand: qty, referenceType: 'transfer', referenceId: t.id, reason: `transfer ${t.number} received`, idempotencyKey: `transfer-receive:${t.id}:${i.variantId}`, actor });
    }
    const lost = i.quantity - qty;
    if (lost > 0) {
      // not received: clear the destination's incoming and return the units to the source so nothing silently vanishes
      await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: t.toWarehouseId, type: 'incoming_add', incoming: -lost, referenceType: 'transfer', referenceId: t.id, reason: `transfer ${t.number} short-received`, idempotencyKey: `transfer-short-in:${t.id}:${i.variantId}`, actor });
      await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: t.fromWarehouseId, type: 'transfer_in', onHand: lost, referenceType: 'transfer', referenceId: t.id, reason: `transfer ${t.number} short-received, returned to source`, idempotencyKey: `transfer-short-back:${t.id}:${i.variantId}`, actor });
    }
    await tx.update(TI).set({ receivedQuantity: qty }).where(eq(TI.id, i.id));
  }
  await tx.update(T).set({ status: 'received', receivedAt: new Date(), version: sql`${T.version} + 1` }).where(eq(T.id, id));
  return loadTransfer(tx, vendorId, id);
}

export async function cancelTransfer(tx: Tx, vendorId: string, id: string, actor?: Actor) {
  const { t, items } = await loadTransfer(tx, vendorId, id, true);
  if (t.status === 'draft') {
    await tx.update(T).set({ status: 'cancelled', version: sql`${T.version} + 1` }).where(eq(T.id, id));
    return loadTransfer(tx, vendorId, id);
  }
  if (t.status !== 'in_transit') throw new AppError('INVALID_STATE', `A ${t.status} transfer cannot be cancelled`, { details: { status: t.status } });
  for (const { i } of items) {
    await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: t.toWarehouseId, type: 'incoming_add', incoming: -i.quantity, referenceType: 'transfer', referenceId: t.id, reason: `transfer ${t.number} cancelled`, idempotencyKey: `transfer-cancel-in:${t.id}:${i.variantId}`, actor });
    await applyMovement(tx, { vendorId, variantId: i.variantId, warehouseId: t.fromWarehouseId, type: 'transfer_in', onHand: i.quantity, referenceType: 'transfer', referenceId: t.id, reason: `transfer ${t.number} cancelled, returned to source`, idempotencyKey: `transfer-cancel-back:${t.id}:${i.variantId}`, actor });
  }
  await tx.update(T).set({ status: 'cancelled', version: sql`${T.version} + 1` }).where(eq(T.id, id));
  return loadTransfer(tx, vendorId, id);
}

export async function listTransfers(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; status?: string }) {
  const ks = keyset<TransferRow>({ sorts: { createdAt: { column: T.createdAt, kind: 'timestamp' } }, idColumn: T.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(T).where(and(eq(T.vendorId, vendorId), q.status ? eq(T.status, q.status) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
  const items = await Promise.all(page.items.map((t) => loadTransfer(tx, vendorId, t.id)));
  return { items: items.map(toTransferDto), nextCursor: page.nextCursor };
}

export { applyMovement, availableOf, nextCounter };

// ------------------------------------------------------------------------------------------------
// routing support: move (part of) a reservation to another warehouse
// ------------------------------------------------------------------------------------------------
export interface MoveReservationInput { vendorId: string; orderId: string; orderItemId: string; variantId: string; fromWarehouseId: string; toWarehouseId: string; quantity: number; actor?: Actor }

/**
 * Re-homes `quantity` units a reservation holds in one warehouse to another one (order routing chose a different warehouse
 * than the one that was reserved at import). Atomic: the units are released from the source and reserved at the target in
 * the same transaction, both through the ledger; if the target cannot cover it nothing changes (INSUFFICIENT_STOCK).
 */
export async function moveReservation(tx: Tx, i: MoveReservationInput): Promise<void> {
  if (i.fromWarehouseId === i.toWarehouseId) return;
  const [from] = await tx.select().from(R).where(and(eq(R.vendorId, i.vendorId), eq(R.orderItemId, i.orderItemId), eq(R.warehouseId, i.fromWarehouseId), eq(R.status, 'active')));
  if (!from || from.quantity < i.quantity) throw new AppError('INVALID_STATE', 'The order line does not hold that many units in the source warehouse', { details: { held: from?.quantity ?? 0, requested: i.quantity } });
  await applyMovement(tx, { vendorId: i.vendorId, variantId: i.variantId, warehouseId: i.fromWarehouseId, type: 'release', reserved: -i.quantity, referenceType: 'order', referenceId: i.orderId, reason: 'rerouted to another warehouse', actor: i.actor });
  await applyMovement(tx, { vendorId: i.vendorId, variantId: i.variantId, warehouseId: i.toWarehouseId, type: 'reserve', reserved: i.quantity, referenceType: 'order', referenceId: i.orderId, reason: 'rerouted from another warehouse', actor: i.actor });
  if (from.quantity === i.quantity) await tx.update(R).set({ status: 'released', releasedAt: new Date() }).where(eq(R.id, from.id));
  else await tx.update(R).set({ quantity: from.quantity - i.quantity }).where(eq(R.id, from.id));
  const [to] = await tx.select().from(R).where(and(eq(R.vendorId, i.vendorId), eq(R.orderItemId, i.orderItemId), eq(R.warehouseId, i.toWarehouseId)));
  if (to) await tx.update(R).set({ quantity: to.status === 'active' ? to.quantity + i.quantity : i.quantity, status: 'active', releasedAt: null }).where(eq(R.id, to.id));
  else await tx.insert(R).values({ vendorId: i.vendorId, orderId: i.orderId, orderItemId: i.orderItemId, variantId: i.variantId, warehouseId: i.toWarehouseId, quantity: i.quantity, status: 'active' });
}

/** how many units of each variant are reservable in each ACTIVE warehouse for this order (its own reservations count as free) */
export async function availabilityByWarehouse(tx: Tx, vendorId: string, variantIds: string[], orderId?: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (variantIds.length === 0) return out;
  const rows = await tx
    .select({ variantId: I.variantId, warehouseId: I.warehouseId, available: sql<number>`${I.quantityOnHand} - ${I.quantityReserved}` })
    .from(I)
    .innerJoin(W, and(eq(W.id, I.warehouseId), eq(W.vendorId, I.vendorId)))
    .where(and(eq(I.vendorId, vendorId), inArray(I.variantId, variantIds), eq(W.status, 'active'), isNull(W.deletedAt)));
  for (const r of rows) (out.get(r.variantId) ?? out.set(r.variantId, new Map()).get(r.variantId)!).set(r.warehouseId, r.available);
  if (orderId) {
    const mine = await tx.select().from(R).where(and(eq(R.vendorId, vendorId), eq(R.orderId, orderId), eq(R.status, 'active')));
    for (const m of mine) { const wm = out.get(m.variantId) ?? out.set(m.variantId, new Map()).get(m.variantId)!; wm.set(m.warehouseId, (wm.get(m.warehouseId) ?? 0) + m.quantity); }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// returned goods: final disposal + manual outbound
// ------------------------------------------------------------------------------------------------
/** returned (awaiting inspection) units that are scrapped / sent back to the supplier: they leave the books */
export async function disposeReturned(tx: Tx, t: Target & { quantity: number }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  return applyMovement(tx, { ...t, type: 'adjust', returned: -t.quantity, referenceType: t.referenceType ?? 'return' });
}

/** damaged stock written off (scrapped, returned to supplier) */
export async function writeOffDamaged(tx: Tx, t: Target & { quantity: number }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  return applyMovement(tx, { ...t, type: 'adjust', damaged: -t.quantity, referenceType: t.referenceType ?? 'adjustment' });
}

/** Stock leaving without an order (B2B issue, sample, internal use): an explicit, reasoned, ledger-backed outbound. */
export async function issueOutbound(tx: Tx, t: Target & { quantity: number }): Promise<MovementResult> {
  await assertStockTargets(tx, t.vendorId, t.variantId, t.warehouseId);
  return applyMovement(tx, { ...t, type: 'adjust', onHand: -t.quantity, referenceType: t.referenceType ?? 'manual', reason: t.reason ?? 'outbound issue' });
}

/** give back part of one order line's reservation in one warehouse (e.g. units that turned out not to exist) */
export async function releaseReservedUnits(tx: Tx, i: { vendorId: string; orderId: string; orderItemId: string; warehouseId: string; quantity: number; reason: string; actor?: Actor }): Promise<void> {
  const [row] = await tx.select().from(R).where(and(eq(R.vendorId, i.vendorId), eq(R.orderItemId, i.orderItemId), eq(R.warehouseId, i.warehouseId), eq(R.status, 'active')));
  if (!row || row.quantity < i.quantity) throw new AppError('INVALID_STATE', 'The order line does not hold that many units in this warehouse', { details: { held: row?.quantity ?? 0, requested: i.quantity } });
  await applyMovement(tx, { vendorId: i.vendorId, variantId: row.variantId, warehouseId: i.warehouseId, type: 'release', reserved: -i.quantity, referenceType: 'order', referenceId: i.orderId, reason: i.reason, actor: i.actor });
  if (row.quantity === i.quantity) await tx.update(R).set({ status: 'released', releasedAt: new Date() }).where(eq(R.id, row.id));
  else await tx.update(R).set({ quantity: row.quantity - i.quantity }).where(eq(R.id, row.id));
}
