import { and, eq, schema, sql, writeOutboxEvent, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';

/**
 * THE only code that changes a stock quantity. One call = one ledger movement + the matching cache update, in the
 * caller's transaction, with the (variant, warehouse) row locked. There is no other write path to `inventory.quantity_*`,
 * so "never overwrite stock without a movement" holds by construction (and `inventory_ledger_drift()` proves it).
 */
const I = schema.inventory;
const M = schema.inventoryMovements;

export type StockRow = typeof I.$inferSelect;
export type MovementType = (typeof schema.MOVEMENT_TYPES)[number];

export interface MovementInput {
  vendorId: string;
  variantId: string;
  warehouseId: string;
  type: MovementType;
  /** signed deltas per bucket */
  onHand?: number;
  reserved?: number;
  incoming?: number;
  damaged?: number;
  returned?: number;
  reason?: string | null;
  referenceType?: 'order' | 'adjustment' | 'transfer' | 'reservation' | 'return' | 'manual' | 'import' | 'count';
  referenceId?: string | null;
  /** same key + vendor = the movement already happened: nothing changes, the original result is returned */
  idempotencyKey?: string | null;
  actor?: { type: 'user' | 'api_key' | 'system' | 'webhook'; id?: string | null };
}

export interface MovementResult {
  duplicate: boolean;
  movementId: number;
  stock: StockRow;
  availableBefore: number;
  availableAfter: number;
}

export const availableOf = (s: Pick<StockRow, 'quantityOnHand' | 'quantityReserved'>): number => s.quantityOnHand - s.quantityReserved;

async function lockStock(tx: Tx, vendorId: string, variantId: string, warehouseId: string): Promise<StockRow> {
  await tx.insert(I).values({ vendorId, variantId, warehouseId }).onConflictDoNothing({ target: [I.vendorId, I.variantId, I.warehouseId] });
  const [row] = await tx.select().from(I).where(and(eq(I.vendorId, vendorId), eq(I.variantId, variantId), eq(I.warehouseId, warehouseId))).for('update');
  return row!;
}

/** confirms the variant and warehouse belong to the vendor (clean 404 instead of a foreign-key error) */
export async function assertStockTargets(tx: Tx, vendorId: string, variantId: string, warehouseId: string): Promise<void> {
  const [v] = await tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.id, variantId), eq(schema.productVariants.vendorId, vendorId)));
  if (!v) throw Errors.notFound('Variant', variantId);
  const [w] = await tx.select({ id: schema.warehouses.id }).from(schema.warehouses).where(and(eq(schema.warehouses.id, warehouseId), eq(schema.warehouses.vendorId, vendorId)));
  if (!w) throw Errors.notFound('Warehouse', warehouseId);
}

export async function applyMovement(tx: Tx, m: MovementInput): Promise<MovementResult> {
  const d = { onHand: m.onHand ?? 0, reserved: m.reserved ?? 0, incoming: m.incoming ?? 0, damaged: m.damaged ?? 0, returned: m.returned ?? 0 };
  if (!d.onHand && !d.reserved && !d.incoming && !d.damaged && !d.returned) throw new AppError('BAD_REQUEST', 'A stock movement must change at least one quantity');

  const before = await lockStock(tx, m.vendorId, m.variantId, m.warehouseId);
  const availableBefore = availableOf(before);

  if (m.idempotencyKey) {
    const [seen] = await tx.select({ id: M.id }).from(M).where(and(eq(M.vendorId, m.vendorId), eq(M.idempotencyKey, m.idempotencyKey)));
    if (seen) return { duplicate: true, movementId: seen.id, stock: before, availableBefore, availableAfter: availableBefore };
  }

  const next = {
    quantityOnHand: before.quantityOnHand + d.onHand,
    quantityReserved: before.quantityReserved + d.reserved,
    quantityIncoming: before.quantityIncoming + d.incoming,
    quantityDamaged: before.quantityDamaged + d.damaged,
    quantityReturned: before.quantityReturned + d.returned,
  };
  if (next.quantityOnHand < 0 || next.quantityReserved > next.quantityOnHand || next.quantityReserved < 0) {
    throw new AppError('INSUFFICIENT_STOCK', next.quantityReserved > next.quantityOnHand && d.reserved > 0 ? 'Not enough available stock to reserve' : 'The change would make stock negative', {
      details: { variantId: m.variantId, warehouseId: m.warehouseId, onHand: before.quantityOnHand, reserved: before.quantityReserved, available: availableBefore, requested: d },
    });
  }
  if (next.quantityIncoming < 0 || next.quantityDamaged < 0 || next.quantityReturned < 0) {
    throw new AppError('INSUFFICIENT_STOCK', 'The change would make a stock bucket negative', { details: { variantId: m.variantId, warehouseId: m.warehouseId, requested: d } });
  }

  const [mv] = await tx
    .insert(M)
    .values({
      vendorId: m.vendorId, variantId: m.variantId, warehouseId: m.warehouseId, type: m.type,
      deltaOnHand: d.onHand, deltaReserved: d.reserved, deltaIncoming: d.incoming, deltaDamaged: d.damaged, deltaReturned: d.returned,
      onHandAfter: next.quantityOnHand, reservedAfter: next.quantityReserved, reason: m.reason ?? null, referenceType: m.referenceType ?? null, referenceId: m.referenceId ?? null,
      idempotencyKey: m.idempotencyKey ?? null, actorType: m.actor?.type ?? 'system', actorId: m.actor?.id ?? null,
    })
    .returning({ id: M.id });
  const [stock] = await tx.update(I).set({ ...next, version: sql`${I.version} + 1` }).where(eq(I.id, before.id)).returning();
  const availableAfter = availableOf(stock!);

  // channels only care when the SELLABLE quantity changes (a shipment commit moves on_hand and reserved together: no change)
  if (availableAfter !== availableBefore) {
    const type = m.type === 'reserve' ? 'inventory.reserved' : m.type === 'release' ? 'inventory.released' : 'inventory.adjusted';
    await writeOutboxEvent(tx, {
      type, vendorId: m.vendorId, aggregateType: 'inventory', aggregateId: stock!.id,
      payload: { variantId: m.variantId, warehouseId: m.warehouseId, movementId: mv!.id, movementType: m.type, availableBefore, availableAfter, onHand: stock!.quantityOnHand, reserved: stock!.quantityReserved },
    });
  }
  if (stock!.reorderLevel !== null && availableAfter <= stock!.reorderLevel && availableBefore > stock!.reorderLevel) {
    await writeOutboxEvent(tx, { type: 'inventory.low_stock', vendorId: m.vendorId, aggregateType: 'inventory', aggregateId: stock!.id, payload: { variantId: m.variantId, warehouseId: m.warehouseId, available: availableAfter, reorderLevel: stock!.reorderLevel } });
  }
  return { duplicate: false, movementId: mv!.id, stock: stock!, availableBefore, availableAfter };
}

/** Atomic per-vendor counter (order numbers, transfer numbers). */
export async function nextCounter(tx: Tx, vendorId: string, name: string): Promise<number> {
  const C = schema.vendorCounters;
  const [row] = await tx
    .insert(C)
    .values({ vendorId, name, value: 1 })
    .onConflictDoUpdate({ target: [C.vendorId, C.name], set: { value: sql`${C.value} + 1` } })
    .returning({ value: C.value });
  return row!.value;
}
