import { and, eq, escapeLike, ilike, isNull, keyset, or, schema, sql, tenantWhere, type SQL, type Tx } from '@oms/database';
import { AppError, Errors, type TenantScope } from '@oms/shared';

export type VendorRow = typeof schema.vendors.$inferSelect;

export function toVendorDto(v: VendorRow) {
  return {
    id: v.id,
    slug: v.slug,
    displayName: v.displayName,
    legalName: v.legalName,
    status: v.status as 'pending' | 'active' | 'suspended' | 'closed',
    statusReason: v.statusReason,
    plan: v.plan,
    businessEmail: v.businessEmail,
    phone: v.phone,
    gstin: v.gstin,
    pan: v.pan,
    address: v.address as Record<string, string>,
    timezone: v.timezone,
    currency: v.currency.trim(),
    settings: v.settings as Record<string, unknown>,
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export async function getVendor(tx: Tx, id: string): Promise<VendorRow> {
  const [v] = await tx.select().from(schema.vendors).where(and(eq(schema.vendors.id, id), isNull(schema.vendors.deletedAt)));
  if (!v) throw Errors.notFound('Vendor', id);
  return v;
}

export type VendorUpdate = Partial<{
  displayName: string; legalName: string; businessEmail: string; phone: string; gstin: string | null; pan: string | null;
  address: Record<string, unknown>; timezone: string; currency: string; version: number;
}>;

export async function updateVendor(tx: Tx, id: string, input: VendorUpdate): Promise<{ before: VendorRow; after: VendorRow }> {
  const before = await getVendor(tx, id);
  if (input.version !== undefined && input.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });
  const { version: _v, ...fields } = input;
  const [after] = await tx
    .update(schema.vendors)
    .set({ ...fields, version: sql`${schema.vendors.version} + 1` })
    .where(eq(schema.vendors.id, id))
    .returning();
  return { before, after: after! };
}

/** Shallow-merge per top-level section so PATCH {notifications:{lowStock:true}} keeps the other notification flags. */
export async function updateSettings(tx: Tx, id: string, patch: Record<string, unknown>): Promise<{ before: VendorRow; after: VendorRow }> {
  const before = await getVendor(tx, id);
  const current = before.settings as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    merged[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...((current[k] as object | undefined) ?? {}), ...v } : v;
  }
  const [after] = await tx.update(schema.vendors).set({ settings: merged, version: sql`${schema.vendors.version} + 1` }).where(eq(schema.vendors.id, id)).returning();
  return { before, after: after! };
}

export interface VendorListInput {
  limit: number; cursor?: string; q?: string; status?: string;
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
}

/** Platform-level vendor directory (cross-tenant; routes gate it with platform:vendors). */
export async function listVendors(tx: Tx, scope: TenantScope, input: VendorListInput) {
  const v = schema.vendors;
  const ks = keyset<VendorRow>({
    sorts: { createdAt: { column: v.createdAt, kind: 'timestamp' }, displayName: { column: v.displayName, kind: 'text' } },
    idColumn: v.id,
    sort: input.sort,
    defaultSort: { field: 'createdAt', direction: 'desc' },
    cursor: input.cursor,
    limit: input.limit,
  });
  const search: SQL | undefined = input.q
    ? or(ilike(v.displayName, `%${escapeLike(input.q)}%`), ilike(v.slug, `%${escapeLike(input.q)}%`), ilike(v.legalName, `%${escapeLike(input.q)}%`))
    : undefined;
  const rows = await tx
    .select()
    .from(v)
    .where(tenantWhere({ vendorId: v.id }, scope, isNull(v.deletedAt), input.status ? eq(v.status, input.status) : undefined, search, ks.where))
    .orderBy(...ks.orderBy)
    .limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: input.sort?.[0]?.field === 'displayName' ? r.displayName : r.createdAt, id: r.id }));
  return { items: page.items.map(toVendorDto), nextCursor: page.nextCursor };
}

/** Platform admins change a vendor's lifecycle status. Suspension takes effect on the next request (cache is invalidated). */
export async function setVendorStatus(tx: Tx, id: string, status: 'active' | 'suspended' | 'closed', reason?: string): Promise<{ before: VendorRow; after: VendorRow }> {
  const before = await getVendor(tx, id);
  const [after] = await tx
    .update(schema.vendors)
    .set({ status, statusReason: reason ?? null, statusChangedAt: new Date(), version: sql`${schema.vendors.version} + 1` })
    .where(eq(schema.vendors.id, id))
    .returning();
  return { before, after: after! };
}
