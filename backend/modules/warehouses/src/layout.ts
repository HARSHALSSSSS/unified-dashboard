import { and, asc, eq, schema, sql, type Tx } from '@oms/database';
import { AppError, Errors, type Principal } from '@oms/shared';
import { getWarehouseRow } from './service';

const L = schema.warehouseLocations;
const B = schema.warehouseBins;
const M = schema.warehouseMembers;
export type Capability = (typeof schema.WAREHOUSE_CAPABILITIES)[number];
export type WarehouseRole = (typeof schema.WAREHOUSE_ROLES)[number];

// ------------------------------------------------------------------------------------------------
// who may do what in a warehouse
// ------------------------------------------------------------------------------------------------
export const ROLE_CAPABILITIES: Record<WarehouseRole, readonly Capability[]> = {
  manager: ['read', 'pick', 'pack', 'receive', 'dispatch', 'adjust', 'manage'],
  picker: ['read', 'pick'],
  packer: ['read', 'pack'],
  receiver: ['read', 'receive'],
  dispatcher: ['read', 'dispatch'],
  viewer: ['read'],
};

export const capabilitiesOf = (m: Pick<typeof M.$inferSelect, 'role' | 'capabilities'>): Set<Capability> => {
  const caps = new Set<Capability>([...(ROLE_CAPABILITIES[m.role as WarehouseRole] ?? []), ...(m.capabilities as Capability[])]);
  if (caps.has('manage')) for (const c of schema.WAREHOUSE_CAPABILITIES) caps.add(c);
  return caps;
};

/**
 * Warehouse-level permission on top of RBAC. A user with NO warehouse membership at all is unrestricted (RBAC alone decides:
 * owners/admins/office staff). As soon as a user is assigned to warehouses they may only act in THOSE warehouses and only
 * with the capabilities of their role: a picker in Delhi cannot pack, nor touch Mumbai. Platform staff are not restricted.
 */
export async function assertWarehouseCapability(tx: Tx, principal: Principal | null, vendorId: string, warehouseId: string, capability: Capability): Promise<void> {
  if (!principal || principal.userType === 'platform') return;
  const mine = await tx.select().from(M).where(and(eq(M.vendorId, vendorId), eq(M.userId, principal.actorId)));
  if (mine.length === 0) return;
  const here = mine.find((m) => m.warehouseId === warehouseId);
  if (!here || !capabilitiesOf(here).has(capability)) {
    throw new AppError('FORBIDDEN', `You are not allowed to ${capability} in this warehouse`, { details: { warehouseId, requiredCapability: capability } });
  }
}

/** warehouses the principal may work in (null = all of them) */
export async function allowedWarehouses(tx: Tx, principal: Principal | null, vendorId: string, capability: Capability = 'read'): Promise<string[] | null> {
  if (!principal || principal.userType === 'platform') return null;
  const mine = await tx.select().from(M).where(and(eq(M.vendorId, vendorId), eq(M.userId, principal.actorId)));
  if (mine.length === 0) return null;
  return mine.filter((m) => capabilitiesOf(m).has(capability)).map((m) => m.warehouseId);
}

// ------------------------------------------------------------------------------------------------
// locations (zones)
// ------------------------------------------------------------------------------------------------
export const toLocationDto = (l: typeof L.$inferSelect) => ({ id: l.id, warehouseId: l.warehouseId, code: l.code, name: l.name, type: l.type as (typeof schema.LOCATION_TYPES)[number], status: l.status as 'active' | 'inactive', version: l.version, createdAt: l.createdAt.toISOString() });

export async function createLocation(tx: Tx, vendorId: string, warehouseId: string, input: { code: string; name: string; type?: (typeof schema.LOCATION_TYPES)[number] }) {
  await getWarehouseRow(tx, vendorId, warehouseId);
  const [row] = await tx.insert(L).values({ vendorId, warehouseId, code: input.code, name: input.name, type: input.type ?? 'storage' }).returning();
  return row!;
}
export async function listLocations(tx: Tx, vendorId: string, warehouseId: string) {
  await getWarehouseRow(tx, vendorId, warehouseId);
  return tx.select().from(L).where(and(eq(L.vendorId, vendorId), eq(L.warehouseId, warehouseId))).orderBy(asc(L.code));
}
export async function getLocation(tx: Tx, vendorId: string, id: string) {
  const [l] = await tx.select().from(L).where(and(eq(L.id, id), eq(L.vendorId, vendorId)));
  if (!l) throw Errors.notFound('Warehouse location', id);
  return l;
}
export async function updateLocation(tx: Tx, vendorId: string, id: string, patch: { name?: string; type?: (typeof schema.LOCATION_TYPES)[number]; status?: 'active' | 'inactive' }) {
  const before = await getLocation(tx, vendorId, id);
  const [after] = await tx.update(L).set({ name: patch.name ?? before.name, type: patch.type ?? before.type, status: patch.status ?? before.status, version: sql`${L.version} + 1` }).where(eq(L.id, id)).returning();
  return { before, after: after! };
}
export async function deleteLocation(tx: Tx, vendorId: string, id: string) {
  const l = await getLocation(tx, vendorId, id);
  const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(B).where(and(eq(B.vendorId, vendorId), eq(B.locationId, id)));
  if ((used?.n ?? 0) > 0) throw new AppError('CONFLICT', 'This location still has bins; move or delete them first', { details: { rule: 'has_bins', bins: used!.n } });
  await tx.delete(L).where(eq(L.id, id));
  return l;
}

// ------------------------------------------------------------------------------------------------
// bins
// ------------------------------------------------------------------------------------------------
export const toBinDto = (b: typeof B.$inferSelect) => ({ id: b.id, warehouseId: b.warehouseId, locationId: b.locationId, code: b.code, barcode: b.barcode, capacity: b.capacity, pickable: b.pickable, status: b.status as (typeof schema.BIN_STATUSES)[number], version: b.version, createdAt: b.createdAt.toISOString() });

export async function createBin(tx: Tx, vendorId: string, warehouseId: string, input: { code: string; barcode?: string | null; locationId?: string | null; capacity?: number | null; pickable?: boolean }) {
  await getWarehouseRow(tx, vendorId, warehouseId);
  if (input.locationId) { const loc = await getLocation(tx, vendorId, input.locationId); if (loc.warehouseId !== warehouseId) throw new AppError('BAD_REQUEST', 'The location belongs to another warehouse', { details: { field: 'locationId' } }); }
  const [row] = await tx.insert(B).values({ vendorId, warehouseId, code: input.code, barcode: input.barcode ?? null, locationId: input.locationId ?? null, capacity: input.capacity ?? null, pickable: input.pickable ?? true }).returning();
  return row!;
}
export async function listBins(tx: Tx, vendorId: string, warehouseId: string) {
  await getWarehouseRow(tx, vendorId, warehouseId);
  return tx.select().from(B).where(and(eq(B.vendorId, vendorId), eq(B.warehouseId, warehouseId))).orderBy(asc(B.code));
}
export async function getBin(tx: Tx, vendorId: string, id: string) {
  const [b] = await tx.select().from(B).where(and(eq(B.id, id), eq(B.vendorId, vendorId)));
  if (!b) throw Errors.notFound('Bin', id);
  return b;
}
export async function findBinByBarcode(tx: Tx, vendorId: string, barcode: string, warehouseId?: string) {
  const [b] = await tx.select().from(B).where(and(eq(B.vendorId, vendorId), eq(B.barcode, barcode), warehouseId ? eq(B.warehouseId, warehouseId) : undefined));
  return b ?? null;
}
export async function updateBin(tx: Tx, vendorId: string, id: string, patch: { barcode?: string | null; locationId?: string | null; capacity?: number | null; pickable?: boolean; status?: (typeof schema.BIN_STATUSES)[number] }) {
  const before = await getBin(tx, vendorId, id);
  if (patch.locationId) { const loc = await getLocation(tx, vendorId, patch.locationId); if (loc.warehouseId !== before.warehouseId) throw new AppError('BAD_REQUEST', 'The location belongs to another warehouse', { details: { field: 'locationId' } }); }
  const [after] = await tx.update(B).set({
    barcode: patch.barcode !== undefined ? patch.barcode : before.barcode, locationId: patch.locationId !== undefined ? patch.locationId : before.locationId, capacity: patch.capacity !== undefined ? patch.capacity : before.capacity,
    pickable: patch.pickable ?? before.pickable, status: patch.status ?? before.status, version: sql`${B.version} + 1`,
  }).where(eq(B.id, id)).returning();
  return { before, after: after! };
}
export async function deleteBin(tx: Tx, vendorId: string, id: string) {
  const b = await getBin(tx, vendorId, id);
  const [stock] = await tx.select({ n: sql<number>`coalesce(sum(${schema.binStock.quantity}), 0)::int` }).from(schema.binStock).where(and(eq(schema.binStock.vendorId, vendorId), eq(schema.binStock.binId, id)));
  if ((stock?.n ?? 0) > 0) throw new AppError('CONFLICT', 'The bin still holds stock; move it out first', { details: { rule: 'has_stock', quantity: stock!.n } });
  await tx.delete(B).where(eq(B.id, id));
  return b;
}

// ------------------------------------------------------------------------------------------------
// members (warehouse users + permissions)
// ------------------------------------------------------------------------------------------------
export const toMemberDto = (m: typeof M.$inferSelect, u?: { email: string; fullName: string }) => ({
  id: m.id, warehouseId: m.warehouseId, userId: m.userId, role: m.role as WarehouseRole, capabilities: m.capabilities as Capability[], effectiveCapabilities: [...capabilitiesOf(m)].sort(),
  ...(u ? { email: u.email, fullName: u.fullName } : {}), createdAt: m.createdAt.toISOString(),
});

export async function addMember(tx: Tx, vendorId: string, warehouseId: string, input: { userId: string; role: WarehouseRole; capabilities?: Capability[] }) {
  await getWarehouseRow(tx, vendorId, warehouseId);
  const [u] = await tx.select({ id: schema.users.id, status: schema.users.status }).from(schema.users).where(and(eq(schema.users.id, input.userId), eq(schema.users.vendorId, vendorId)));
  if (!u) throw Errors.notFound('User', input.userId);
  const [row] = await tx.insert(M).values({ vendorId, warehouseId, userId: input.userId, role: input.role, capabilities: input.capabilities ?? [] }).onConflictDoUpdate({ target: [M.warehouseId, M.userId], set: { role: input.role, capabilities: input.capabilities ?? [] } }).returning();
  return row!;
}
export async function listMembers(tx: Tx, vendorId: string, warehouseId: string) {
  await getWarehouseRow(tx, vendorId, warehouseId);
  return tx.select({ m: M, email: schema.users.email, fullName: schema.users.fullName }).from(M).innerJoin(schema.users, eq(schema.users.id, M.userId)).where(and(eq(M.vendorId, vendorId), eq(M.warehouseId, warehouseId))).orderBy(asc(schema.users.fullName));
}
export async function getMember(tx: Tx, vendorId: string, id: string) {
  const [m] = await tx.select().from(M).where(and(eq(M.id, id), eq(M.vendorId, vendorId)));
  if (!m) throw Errors.notFound('Warehouse member', id);
  return m;
}
export async function updateMember(tx: Tx, vendorId: string, id: string, patch: { role?: WarehouseRole; capabilities?: Capability[] }) {
  const before = await getMember(tx, vendorId, id);
  const [after] = await tx.update(M).set({ role: patch.role ?? before.role, capabilities: patch.capabilities ?? before.capabilities }).where(eq(M.id, id)).returning();
  return { before, after: after! };
}
export async function removeMember(tx: Tx, vendorId: string, id: string) {
  const m = await getMember(tx, vendorId, id);
  await tx.delete(M).where(eq(M.id, id));
  return m;
}
export async function myAccess(tx: Tx, principal: Principal | null, vendorId: string) {
  if (!principal) return { restricted: false, warehouses: [] as Array<{ warehouseId: string; role: string; capabilities: Capability[] }> };
  const mine = await tx.select().from(M).where(and(eq(M.vendorId, vendorId), eq(M.userId, principal.actorId)));
  return { restricted: mine.length > 0, warehouses: mine.map((m) => ({ warehouseId: m.warehouseId, role: m.role, capabilities: [...capabilitiesOf(m)].sort() as Capability[] })) };
}
