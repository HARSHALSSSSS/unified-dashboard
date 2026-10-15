import { and, asc, eq, ilike, isNull, keyset, or, schema, sql, escapeLike, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';

const W = schema.warehouses;
export type WarehouseRow = typeof W.$inferSelect;

export const toWarehouseDto = (w: WarehouseRow) => ({
  id: w.id, code: w.code, name: w.name, address: w.address, status: w.status as 'active' | 'inactive', isDefault: w.isDefault, priority: w.priority, version: w.version,
  createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString(),
});

export async function getWarehouseRow(tx: Tx, vendorId: string, id: string): Promise<WarehouseRow> {
  const [w] = await tx.select().from(W).where(and(eq(W.id, id), eq(W.vendorId, vendorId), isNull(W.deletedAt)));
  if (!w) throw Errors.notFound('Warehouse', id);
  return w;
}

export interface WarehouseInput { code: string; name: string; address?: Record<string, unknown>; priority?: number; isDefault?: boolean }

export async function createWarehouse(tx: Tx, vendorId: string, input: WarehouseInput): Promise<WarehouseRow> {
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(W).where(and(eq(W.vendorId, vendorId), isNull(W.deletedAt)));
  // the first warehouse is the default; a later one only if explicitly asked
  const makeDefault = n === 0 || input.isDefault === true;
  if (makeDefault && n > 0) await tx.update(W).set({ isDefault: false }).where(and(eq(W.vendorId, vendorId), eq(W.isDefault, true), isNull(W.deletedAt)));
  const [row] = await tx.insert(W).values({ vendorId, code: input.code, name: input.name, address: input.address ?? {}, priority: input.priority ?? 100, isDefault: makeDefault }).returning();
  return row!;
}

export async function updateWarehouse(tx: Tx, vendorId: string, id: string, patch: Partial<WarehouseInput> & { status?: 'active' | 'inactive'; version?: number }) {
  const before = await getWarehouseRow(tx, vendorId, id);
  if (patch.version !== undefined && patch.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });
  if (patch.status === 'inactive' && before.isDefault) throw new AppError('CONFLICT', 'Make another warehouse the default before deactivating this one', { details: { rule: 'default_warehouse' } });
  if (patch.status === 'inactive') await assertNoCommitments(tx, vendorId, id);
  if (patch.isDefault === false && before.isDefault) throw new AppError('CONFLICT', 'Choose another default warehouse instead of unsetting this one', { details: { rule: 'default_warehouse' } });
  if (patch.isDefault === true && !before.isDefault) {
    if (before.status !== 'active') throw new AppError('CONFLICT', 'An inactive warehouse cannot be the default');
    await tx.update(W).set({ isDefault: false }).where(and(eq(W.vendorId, vendorId), eq(W.isDefault, true), isNull(W.deletedAt)));
  }
  const [after] = await tx
    .update(W)
    .set({
      code: patch.code ?? before.code, name: patch.name ?? before.name, address: patch.address ?? before.address, priority: patch.priority ?? before.priority,
      status: patch.status ?? before.status, isDefault: patch.isDefault ?? before.isDefault, version: sql`${W.version} + 1`,
    })
    .where(eq(W.id, id))
    .returning();
  return { before, after: after! };
}

/** a warehouse still holding promised stock cannot go away: the reservations would point nowhere */
async function assertNoCommitments(tx: Tx, vendorId: string, id: string): Promise<void> {
  const [row] = await tx
    .select({ reserved: sql<number>`coalesce(sum(${schema.inventory.quantityReserved}), 0)::int`, onHand: sql<number>`coalesce(sum(${schema.inventory.quantityOnHand}), 0)::int` })
    .from(schema.inventory)
    .where(and(eq(schema.inventory.vendorId, vendorId), eq(schema.inventory.warehouseId, id)));
  if ((row?.reserved ?? 0) > 0) throw new AppError('CONFLICT', 'This warehouse still has stock reserved for orders', { details: { rule: 'has_reservations', reserved: row!.reserved } });
}

export async function deleteWarehouse(tx: Tx, vendorId: string, id: string): Promise<WarehouseRow> {
  const w = await getWarehouseRow(tx, vendorId, id);
  if (w.isDefault) throw new AppError('CONFLICT', 'The default warehouse cannot be deleted', { details: { rule: 'default_warehouse' } });
  const [row] = await tx
    .select({ onHand: sql<number>`coalesce(sum(${schema.inventory.quantityOnHand} + ${schema.inventory.quantityIncoming} + ${schema.inventory.quantityDamaged} + ${schema.inventory.quantityReturned}), 0)::int` })
    .from(schema.inventory)
    .where(and(eq(schema.inventory.vendorId, vendorId), eq(schema.inventory.warehouseId, id)));
  if ((row?.onHand ?? 0) > 0) throw new AppError('CONFLICT', 'The warehouse still holds stock; transfer or adjust it to zero first, or deactivate it instead', { details: { rule: 'has_stock', quantity: row!.onHand } });
  await tx.update(W).set({ deletedAt: new Date(), isDefault: false, status: 'inactive', code: sql`${W.code} || '~' || substr(${W.id}::text, 1, 8)` }).where(eq(W.id, id));
  return w;
}

export interface WarehouseListInput { limit: number; cursor?: string; q?: string; status?: string }

export async function listWarehouses(tx: Tx, vendorId: string, input: WarehouseListInput) {
  const ks = keyset<WarehouseRow>({ sorts: { createdAt: { column: W.createdAt, kind: 'timestamp' } }, idColumn: W.id, defaultSort: { field: 'createdAt', direction: 'asc' }, cursor: input.cursor, limit: input.limit });
  const search = input.q ? or(ilike(W.code, `%${escapeLike(input.q)}%`), ilike(W.name, `%${escapeLike(input.q)}%`)) : undefined;
  const rows = await tx
    .select()
    .from(W)
    .where(and(eq(W.vendorId, vendorId), isNull(W.deletedAt), input.status ? eq(W.status, input.status) : undefined, search, ks.where))
    .orderBy(...ks.orderBy)
    .limit(ks.fetch);
  return ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
}

/** active warehouses in allocation order: default first, then lower priority number, then oldest */
export async function allocationOrder(tx: Tx, vendorId: string, only?: string[]): Promise<WarehouseRow[]> {
  const rows = await tx.select().from(W).where(and(eq(W.vendorId, vendorId), eq(W.status, 'active'), isNull(W.deletedAt))).orderBy(asc(W.priority), asc(W.createdAt));
  const ordered = [...rows].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.priority - b.priority);
  return only?.length ? ordered.filter((w) => only.includes(w.id)) : ordered;
}
