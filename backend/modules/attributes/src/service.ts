import { and, asc, eq, escapeLike, ilike, inArray, isNull, keyset, or, schema, sql, type SQL, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';

export type AttributeRow = typeof schema.attributeDefinitions.$inferSelect;
export type AttributeValueRow = typeof schema.attributeValues.$inferSelect;
export type AttributeType = 'text' | 'number' | 'boolean' | 'date' | 'enum';

const D = schema.attributeDefinitions;
const V = schema.attributeValues;

export const toValueDto = (v: AttributeValueRow) => ({ id: v.id, value: v.value, label: v.label, sortOrder: v.sortOrder });

export const toAttributeDto = (a: AttributeRow, values: AttributeValueRow[] = []) => ({
  id: a.id,
  code: a.code,
  name: a.name,
  dataType: a.dataType as AttributeType,
  appliesTo: a.appliesTo as 'product' | 'variant',
  unit: a.unit,
  description: a.description,
  values: values.filter((v) => v.attributeId === a.id).sort((x, y) => x.sortOrder - y.sortOrder || x.label.localeCompare(y.label)).map(toValueDto),
  version: a.version,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

const liveDef = (vendorId: string) => and(eq(D.vendorId, vendorId), isNull(D.deletedAt));

export async function getAttribute(tx: Tx, vendorId: string, id: string): Promise<AttributeRow> {
  const [a] = await tx.select().from(D).where(and(eq(D.id, id), liveDef(vendorId)));
  if (!a) throw Errors.notFound('Attribute', id);
  return a;
}

async function valuesOf(tx: Tx, vendorId: string, attributeIds: string[]): Promise<AttributeValueRow[]> {
  if (!attributeIds.length) return [];
  return tx.select().from(V).where(and(eq(V.vendorId, vendorId), inArray(V.attributeId, attributeIds), isNull(V.deletedAt)));
}

export async function getAttributeWithValues(tx: Tx, vendorId: string, id: string) {
  const a = await getAttribute(tx, vendorId, id);
  return toAttributeDto(a, await valuesOf(tx, vendorId, [id]));
}

export interface CreateAttributeInput {
  code: string; name: string; dataType: AttributeType; appliesTo: 'product' | 'variant'; unit?: string; description?: string;
  values?: Array<{ value: string; label?: string; sortOrder?: number }>;
}

export async function createAttribute(tx: Tx, vendorId: string, input: CreateAttributeInput) {
  if (input.values?.length && input.dataType !== 'enum') throw Errors.validation({ issues: [{ path: 'values', message: 'Only enum attributes have values' }] });
  const [a] = await tx.insert(D).values({ vendorId, code: input.code, name: input.name, dataType: input.dataType, appliesTo: input.appliesTo, unit: input.unit ?? null, description: input.description ?? null }).returning();
  if (input.values?.length) {
    await tx.insert(V).values(input.values.map((v, i) => ({ vendorId, attributeId: a!.id, value: v.value, label: v.label ?? v.value, sortOrder: v.sortOrder ?? i })));
  }
  return getAttributeWithValues(tx, vendorId, a!.id);
}

export async function updateAttribute(tx: Tx, vendorId: string, id: string, input: { name?: string; unit?: string | null; description?: string | null; version?: number }) {
  const before = await getAttribute(tx, vendorId, id);
  if (input.version !== undefined && input.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });
  await tx.update(D).set({ name: input.name ?? before.name, unit: input.unit === undefined ? before.unit : input.unit, description: input.description === undefined ? before.description : input.description, version: sql`${D.version} + 1` }).where(eq(D.id, id));
  return { before, after: await getAttributeWithValues(tx, vendorId, id) };
}

async function isUsed(tx: Tx, vendorId: string, attributeId: string): Promise<boolean> {
  const [row] = await tx.select({ id: schema.productAttributeValues.id }).from(schema.productAttributeValues).where(and(eq(schema.productAttributeValues.vendorId, vendorId), eq(schema.productAttributeValues.attributeId, attributeId))).limit(1);
  return Boolean(row);
}

export async function deleteAttribute(tx: Tx, vendorId: string, id: string) {
  const a = await getAttribute(tx, vendorId, id);
  if (await isUsed(tx, vendorId, id)) throw new AppError('CONFLICT', 'Attribute is used by products; clear its values first', { details: { rule: 'in_use' } });
  await tx.update(D).set({ deletedAt: new Date() }).where(eq(D.id, id));
  await tx.update(V).set({ deletedAt: new Date() }).where(and(eq(V.attributeId, id), isNull(V.deletedAt)));
  await tx.delete(schema.categoryAttributes).where(eq(schema.categoryAttributes.attributeId, id));
  return a;
}

export interface AttributeListInput { limit: number; cursor?: string; q?: string; dataType?: string; appliesTo?: string; sort?: Array<{ field: string; direction: 'asc' | 'desc' }> }

export async function listAttributes(tx: Tx, vendorId: string, input: AttributeListInput) {
  const ks = keyset<AttributeRow>({
    sorts: { name: { column: D.name, kind: 'text' }, code: { column: D.code, kind: 'text' }, createdAt: { column: D.createdAt, kind: 'timestamp' } },
    idColumn: D.id,
    sort: input.sort,
    defaultSort: { field: 'name', direction: 'asc' },
    cursor: input.cursor,
    limit: input.limit,
  });
  const search: SQL | undefined = input.q ? or(ilike(D.name, `%${escapeLike(input.q)}%`), ilike(D.code, `%${escapeLike(input.q)}%`)) : undefined;
  const rows = await tx
    .select().from(D)
    .where(and(liveDef(vendorId), input.dataType ? eq(D.dataType, input.dataType) : undefined, input.appliesTo ? eq(D.appliesTo, input.appliesTo) : undefined, search, ks.where))
    .orderBy(...ks.orderBy).limit(ks.fetch);
  const field = input.sort?.[0]?.field ?? 'name';
  const page = ks.finish(rows, (r) => ({ sortValue: field === 'code' ? r.code : field === 'createdAt' ? r.createdAt : r.name, id: r.id }));
  const values = await valuesOf(tx, vendorId, page.items.map((a) => a.id));
  return { items: page.items.map((a) => toAttributeDto(a, values)), nextCursor: page.nextCursor };
}

// ------------------------------------------------------------------------------------------------
// enum values
// ------------------------------------------------------------------------------------------------
export async function addValue(tx: Tx, vendorId: string, attributeId: string, input: { value: string; label?: string; sortOrder?: number }) {
  const a = await getAttribute(tx, vendorId, attributeId);
  if (a.dataType !== 'enum') throw new AppError('CONFLICT', 'Only enum attributes have values');
  const [v] = await tx.insert(V).values({ vendorId, attributeId, value: input.value, label: input.label ?? input.value, sortOrder: input.sortOrder ?? 0 }).returning();
  return toValueDto(v!);
}

async function getValue(tx: Tx, vendorId: string, attributeId: string, valueId: string): Promise<AttributeValueRow> {
  const [v] = await tx.select().from(V).where(and(eq(V.id, valueId), eq(V.attributeId, attributeId), eq(V.vendorId, vendorId), isNull(V.deletedAt)));
  if (!v) throw Errors.notFound('Attribute value', valueId);
  return v;
}

export async function updateValue(tx: Tx, vendorId: string, attributeId: string, valueId: string, input: { label?: string; sortOrder?: number }) {
  const v = await getValue(tx, vendorId, attributeId, valueId);
  const [after] = await tx.update(V).set({ label: input.label ?? v.label, sortOrder: input.sortOrder ?? v.sortOrder }).where(eq(V.id, valueId)).returning();
  return toValueDto(after!);
}

export async function deleteValue(tx: Tx, vendorId: string, attributeId: string, valueId: string) {
  const v = await getValue(tx, vendorId, attributeId, valueId);
  const [used] = await tx.select({ id: schema.productAttributeValues.id }).from(schema.productAttributeValues).where(eq(schema.productAttributeValues.attributeValueId, valueId)).limit(1);
  if (used) throw new AppError('CONFLICT', 'Value is used by products', { details: { rule: 'in_use' } });
  await tx.update(V).set({ deletedAt: new Date() }).where(eq(V.id, valueId));
  return v;
}

// ------------------------------------------------------------------------------------------------
// category assignments
// ------------------------------------------------------------------------------------------------
export async function getCategoryAttributes(tx: Tx, vendorId: string, categoryId: string) {
  const [cat] = await tx.select({ id: schema.categories.id }).from(schema.categories).where(and(eq(schema.categories.id, categoryId), eq(schema.categories.vendorId, vendorId), isNull(schema.categories.deletedAt)));
  if (!cat) throw Errors.notFound('Category', categoryId);
  const links = await tx.select().from(schema.categoryAttributes).where(and(eq(schema.categoryAttributes.vendorId, vendorId), eq(schema.categoryAttributes.categoryId, categoryId))).orderBy(asc(schema.categoryAttributes.sortOrder));
  const defs = links.length ? await tx.select().from(D).where(and(eq(D.vendorId, vendorId), inArray(D.id, links.map((l) => l.attributeId)), isNull(D.deletedAt))) : [];
  const values = await valuesOf(tx, vendorId, defs.map((d) => d.id));
  return links.flatMap((l) => {
    const d = defs.find((x) => x.id === l.attributeId);
    return d ? [{ isRequired: l.isRequired, sortOrder: l.sortOrder, attribute: toAttributeDto(d, values) }] : [];
  });
}

/** Replace the attribute set of a category. */
export async function setCategoryAttributes(tx: Tx, vendorId: string, categoryId: string, items: Array<{ attributeId: string; isRequired?: boolean; sortOrder?: number }>) {
  await getCategoryAttributes(tx, vendorId, categoryId); // existence check
  const ids = [...new Set(items.map((i) => i.attributeId))];
  if (ids.length !== items.length) throw Errors.validation({ issues: [{ path: 'items', message: 'duplicate attributeId' }] });
  if (ids.length) {
    const found = await tx.select({ id: D.id }).from(D).where(and(liveDef(vendorId), inArray(D.id, ids)));
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw Errors.notFound('Attribute', missing[0]);
  }
  await tx.delete(schema.categoryAttributes).where(and(eq(schema.categoryAttributes.vendorId, vendorId), eq(schema.categoryAttributes.categoryId, categoryId)));
  if (items.length) await tx.insert(schema.categoryAttributes).values(items.map((i, n) => ({ vendorId, categoryId, attributeId: i.attributeId, isRequired: i.isRequired ?? false, sortOrder: i.sortOrder ?? n })));
  return getCategoryAttributes(tx, vendorId, categoryId);
}

// ------------------------------------------------------------------------------------------------
// product attribute values (used by the catalog module)
// ------------------------------------------------------------------------------------------------
export type RawValue = string | number | boolean | null;
export interface ProductValueInput { attributeId: string; variantId?: string | null; value: RawValue }

function typed(def: AttributeRow, raw: Exclude<RawValue, null>, enumValues: AttributeValueRow[]): Partial<typeof schema.productAttributeValues.$inferInsert> {
  const bad = (msg: string) => Errors.validation({ issues: [{ path: `values.${def.code}`, message: msg }] });
  switch (def.dataType as AttributeType) {
    case 'text':
      if (typeof raw !== 'string' || raw.length > 2000) throw bad('must be text up to 2000 characters');
      return { valueText: raw };
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) throw bad('must be a number');
      return { valueNumber: String(n) };
    }
    case 'boolean':
      if (typeof raw !== 'boolean') throw bad('must be true or false');
      return { valueBool: raw };
    case 'date':
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) throw bad('must be a date (YYYY-MM-DD)');
      return { valueDate: raw };
    case 'enum': {
      const match = enumValues.find((v) => v.attributeId === def.id && v.value === raw);
      if (typeof raw !== 'string' || !match) throw bad(`must be one of: ${enumValues.filter((v) => v.attributeId === def.id).map((v) => v.value).join(', ') || '(no values defined)'}`);
      return { valueText: raw, attributeValueId: match.id };
    }
  }
}

/** Set (value) or clear (null) attribute values for a product / its variants. Validates type, scope and enum membership. */
export async function setProductAttributeValues(tx: Tx, vendorId: string, productId: string, entries: ProductValueInput[]): Promise<void> {
  if (!entries.length) return;
  const defIds = [...new Set(entries.map((e) => e.attributeId))];
  const defs = await tx.select().from(D).where(and(liveDef(vendorId), inArray(D.id, defIds)));
  const enumValues = await valuesOf(tx, vendorId, defs.filter((d) => d.dataType === 'enum').map((d) => d.id));
  const variantIds = [...new Set(entries.flatMap((e) => (e.variantId ? [e.variantId] : [])))];
  const variants = variantIds.length
    ? await tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.vendorId, vendorId), eq(schema.productVariants.productId, productId), inArray(schema.productVariants.id, variantIds), isNull(schema.productVariants.deletedAt)))
    : [];

  for (const e of entries) {
    const def = defs.find((d) => d.id === e.attributeId);
    if (!def) throw Errors.notFound('Attribute', e.attributeId);
    if (def.appliesTo === 'variant' && !e.variantId) throw Errors.validation({ issues: [{ path: `values.${def.code}`, message: 'variant attribute needs a variantId' }] });
    if (def.appliesTo === 'product' && e.variantId) throw Errors.validation({ issues: [{ path: `values.${def.code}`, message: 'product attribute must not have a variantId' }] });
    if (e.variantId && !variants.some((v) => v.id === e.variantId)) throw Errors.notFound('Variant', e.variantId);

    const where = and(
      eq(schema.productAttributeValues.vendorId, vendorId), eq(schema.productAttributeValues.productId, productId), eq(schema.productAttributeValues.attributeId, e.attributeId),
      e.variantId ? eq(schema.productAttributeValues.variantId, e.variantId) : isNull(schema.productAttributeValues.variantId),
    );
    await tx.delete(schema.productAttributeValues).where(where);
    if (e.value === null) continue;
    await tx.insert(schema.productAttributeValues).values({ vendorId, productId, variantId: e.variantId ?? null, attributeId: e.attributeId, ...typed(def, e.value, enumValues) });
  }
}

export async function getProductAttributeValues(tx: Tx, vendorId: string, productId: string) {
  const rows = await tx
    .select({ pv: schema.productAttributeValues, def: D })
    .from(schema.productAttributeValues)
    .innerJoin(D, eq(D.id, schema.productAttributeValues.attributeId))
    .where(and(eq(schema.productAttributeValues.vendorId, vendorId), eq(schema.productAttributeValues.productId, productId)));
  return rows.map(({ pv, def }) => ({
    attributeId: def.id,
    code: def.code,
    name: def.name,
    dataType: def.dataType as AttributeType,
    variantId: pv.variantId,
    value: (def.dataType === 'number' ? Number(pv.valueNumber) : def.dataType === 'boolean' ? pv.valueBool : def.dataType === 'date' ? pv.valueDate : pv.valueText) as RawValue,
  }));
}

/** Attributes a category requires (used for marketplace-readiness checks). */
export async function requiredAttributesForCategory(tx: Tx, vendorId: string, categoryId: string): Promise<Array<{ id: string; code: string; name: string; appliesTo: 'product' | 'variant' }>> {
  const rows = await tx
    .select({ d: D })
    .from(schema.categoryAttributes)
    .innerJoin(D, eq(D.id, schema.categoryAttributes.attributeId))
    .where(and(eq(schema.categoryAttributes.vendorId, vendorId), eq(schema.categoryAttributes.categoryId, categoryId), eq(schema.categoryAttributes.isRequired, true), isNull(D.deletedAt)));
  return rows.map((r) => ({ id: r.d.id, code: r.d.code, name: r.d.name, appliesTo: r.d.appliesTo as 'product' | 'variant' }));
}
