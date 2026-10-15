import { and, asc, desc, eq, gt, schema, sql, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { assertStockTargets } from './ledger';

const BS = schema.binStock;
const B = schema.warehouseBins;
const I = schema.inventory;

/**
 * Where inside a warehouse stock sits. `inventory.quantity_on_hand` stays the truth about HOW MUCH; bin stock only adds
 * WHERE. Invariant (checked on every write): for a (variant, warehouse), sum(bin quantities) <= on_hand. The difference is
 * "unbinned" stock (received but not put away yet). Picking removes units from bins when they are picked; the unit stays
 * in on_hand until it is dispatched, so the invariant holds all the way.
 */
async function onHandOf(tx: Tx, vendorId: string, variantId: string, warehouseId: string): Promise<number> {
  const [row] = await tx.select({ n: I.quantityOnHand }).from(I).where(and(eq(I.vendorId, vendorId), eq(I.variantId, variantId), eq(I.warehouseId, warehouseId)));
  return row?.n ?? 0;
}
async function binnedOf(tx: Tx, vendorId: string, variantId: string, warehouseId: string): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`coalesce(sum(${BS.quantity}), 0)::int` }).from(BS).where(and(eq(BS.vendorId, vendorId), eq(BS.variantId, variantId), eq(BS.warehouseId, warehouseId)));
  return row?.n ?? 0;
}

async function loadBin(tx: Tx, vendorId: string, warehouseId: string, binId: string, lock = false) {
  const q = tx.select().from(B).where(and(eq(B.id, binId), eq(B.vendorId, vendorId)));
  const [b] = await (lock ? q.for('update') : q);
  if (!b) throw Errors.notFound('Bin', binId);
  if (b.warehouseId !== warehouseId) throw new AppError('BAD_REQUEST', 'The bin belongs to another warehouse', { details: { binId, warehouseId } });
  return b;
}

async function bump(tx: Tx, vendorId: string, warehouseId: string, binId: string, variantId: string, delta: number): Promise<void> {
  await tx
    .insert(BS)
    .values({ vendorId, warehouseId, binId, variantId, quantity: Math.max(0, delta) })
    .onConflictDoUpdate({ target: [BS.binId, BS.variantId], set: { quantity: sql`${BS.quantity} + ${delta}` } });
}

export interface BinOpInput { vendorId: string; variantId: string; warehouseId: string; binId: string; quantity: number }

/** Put units into a bin (from the unbinned part of the warehouse). Cannot bin more than the warehouse holds, nor exceed capacity. */
/** the destination bin must stay within its capacity (checked under the bin's row lock) */
async function assertCapacity(tx: Tx, vendorId: string, bin: { id: string; code: string; capacity: number | null }, add: number): Promise<void> {
  if (bin.capacity === null) return;
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`coalesce(sum(${BS.quantity}), 0)::int` }).from(BS).where(and(eq(BS.vendorId, vendorId), eq(BS.binId, bin.id)));
  if (n + add > bin.capacity) throw new AppError('CONFLICT', `Bin ${bin.code} would exceed its capacity`, { details: { rule: 'bin_capacity', capacity: bin.capacity, current: n, requested: add } });
}

export async function addToBin(tx: Tx, i: BinOpInput): Promise<void> {
  await assertStockTargets(tx, i.vendorId, i.variantId, i.warehouseId);
  // lock the stock row and the bin: two concurrent put-aways must not both pass the "unbinned units" and capacity checks
  await tx.select({ id: I.id }).from(I).where(and(eq(I.vendorId, i.vendorId), eq(I.variantId, i.variantId), eq(I.warehouseId, i.warehouseId))).for('update');
  const bin = await loadBin(tx, i.vendorId, i.warehouseId, i.binId, true);
  if (bin.status !== 'active') throw new AppError('CONFLICT', `Bin ${bin.code} is ${bin.status}`, { details: { rule: 'bin_not_active' } });
  const [onHand, binned] = [await onHandOf(tx, i.vendorId, i.variantId, i.warehouseId), await binnedOf(tx, i.vendorId, i.variantId, i.warehouseId)];
  if (binned + i.quantity > onHand) throw new AppError('INSUFFICIENT_STOCK', 'More units than the warehouse holds unbinned', { details: { onHand, binned, unbinned: onHand - binned, requested: i.quantity } });
  await assertCapacity(tx, i.vendorId, bin, i.quantity);
  await bump(tx, i.vendorId, i.warehouseId, i.binId, i.variantId, i.quantity);
}

/** Take units out of a bin (picked, moved, or the bin was emptied). */
export async function removeFromBin(tx: Tx, i: BinOpInput): Promise<void> {
  // ONE atomic statement with its own guard: concurrent pickers on the same bin cannot both subtract from the same stale number
  const done = await tx.update(BS).set({ quantity: sql`${BS.quantity} - ${i.quantity}` }).where(and(eq(BS.vendorId, i.vendorId), eq(BS.binId, i.binId), eq(BS.variantId, i.variantId), sql`${BS.quantity} >= ${i.quantity}`)).returning({ id: BS.id });
  if (done.length === 0) {
    const [row] = await tx.select().from(BS).where(and(eq(BS.vendorId, i.vendorId), eq(BS.binId, i.binId), eq(BS.variantId, i.variantId)));
    throw new AppError('INSUFFICIENT_STOCK', 'The bin does not hold that many units', { details: { binId: i.binId, held: row?.quantity ?? 0, requested: i.quantity } });
  }
}

/** Move units between bins of the same warehouse. */
export async function moveBetweenBins(tx: Tx, i: BinOpInput & { toBinId: string }): Promise<void> {
  if (i.binId === i.toBinId) throw new AppError('BAD_REQUEST', 'Source and destination bins are the same');
  const dest = await loadBin(tx, i.vendorId, i.warehouseId, i.toBinId, true);
  if (dest.status !== 'active') throw new AppError('CONFLICT', `Bin ${dest.code} is ${dest.status}`, { details: { rule: 'bin_not_active' } });
  await assertCapacity(tx, i.vendorId, dest, i.quantity);
  await loadBin(tx, i.vendorId, i.warehouseId, i.binId);
  await removeFromBin(tx, i);
  await bump(tx, i.vendorId, i.warehouseId, i.toBinId, i.variantId, i.quantity);
}

/** Pickable bins holding the variant, fullest first: the suggestion a pick list is built from. */
export async function suggestBins(tx: Tx, vendorId: string, variantId: string, warehouseId: string, quantity: number): Promise<Array<{ binId: string | null; quantity: number }>> {
  const rows = await tx
    .select({ binId: BS.binId, quantity: BS.quantity })
    .from(BS)
    .innerJoin(B, and(eq(B.id, BS.binId), eq(B.vendorId, BS.vendorId)))
    .where(and(eq(BS.vendorId, vendorId), eq(BS.variantId, variantId), eq(BS.warehouseId, warehouseId), gt(BS.quantity, 0), eq(B.pickable, true), eq(B.status, 'active')))
    .orderBy(desc(BS.quantity), asc(B.code));
  const out: Array<{ binId: string | null; quantity: number }> = [];
  let left = quantity;
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(r.quantity, left);
    out.push({ binId: r.binId, quantity: take });
    left -= take;
  }
  if (left > 0) out.push({ binId: null, quantity: left }); // unbinned stock: the picker finds it on the floor
  return out;
}

export async function binStockOf(tx: Tx, vendorId: string, f: { warehouseId?: string; variantId?: string; binId?: string }) {
  const rows = await tx
    .select({ bs: BS, binCode: B.code, binBarcode: B.barcode, sku: schema.productVariants.sku })
    .from(BS)
    .innerJoin(B, and(eq(B.id, BS.binId), eq(B.vendorId, BS.vendorId)))
    .innerJoin(schema.productVariants, and(eq(schema.productVariants.id, BS.variantId), eq(schema.productVariants.vendorId, BS.vendorId)))
    .where(and(eq(BS.vendorId, vendorId), gt(BS.quantity, 0), f.warehouseId ? eq(BS.warehouseId, f.warehouseId) : undefined, f.variantId ? eq(BS.variantId, f.variantId) : undefined, f.binId ? eq(BS.binId, f.binId) : undefined))
    .orderBy(asc(B.code), asc(schema.productVariants.sku))
    .limit(1000);
  return rows.map((r) => ({ binId: r.bs.binId, binCode: r.binCode, binBarcode: r.binBarcode, warehouseId: r.bs.warehouseId, variantId: r.bs.variantId, sku: r.sku, quantity: r.bs.quantity }));
}

/** For a variant: where is it, per warehouse and bin, and how much is not binned yet. */
export async function stockLocations(tx: Tx, vendorId: string, variantId: string) {
  const inv = await tx.select({ warehouseId: I.warehouseId, onHand: I.quantityOnHand, reserved: I.quantityReserved }).from(I).where(and(eq(I.vendorId, vendorId), eq(I.variantId, variantId)));
  const bins = await binStockOf(tx, vendorId, { variantId });
  return inv.map((w) => {
    const mine = bins.filter((b) => b.warehouseId === w.warehouseId);
    const binned = mine.reduce((n, b) => n + b.quantity, 0);
    return { warehouseId: w.warehouseId, onHand: w.onHand, reserved: w.reserved, binned, unbinned: w.onHand - binned, bins: mine.map((b) => ({ binId: b.binId, binCode: b.binCode, quantity: b.quantity })) };
  });
}
