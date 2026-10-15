import { and, eq, escapeLike, ilike, isNull, keyset, like, or, schema, sql, type SQL, type Tx } from '@oms/database';
import { AppError, Errors, slugify } from '@oms/shared';

export type CategoryRow = typeof schema.categories.$inferSelect;

export const toCategoryDto = (c: CategoryRow) => ({
  id: c.id,
  parentId: c.parentId,
  name: c.name,
  slug: c.slug,
  path: c.path,
  sortOrder: c.sortOrder,
  version: c.version,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

const live = (vendorId: string) => and(eq(schema.categories.vendorId, vendorId), isNull(schema.categories.deletedAt));

export async function getCategory(tx: Tx, vendorId: string, id: string): Promise<CategoryRow> {
  const [c] = await tx.select().from(schema.categories).where(and(eq(schema.categories.id, id), live(vendorId)));
  if (!c) throw Errors.notFound('Category', id);
  return c;
}

export async function createCategory(tx: Tx, vendorId: string, input: { name: string; slug?: string; parentId?: string | null; sortOrder?: number }) {
  const parent = input.parentId ? await getCategory(tx, vendorId, input.parentId) : null;
  const slug = slugify(input.slug ?? input.name, 60);
  const [row] = await tx
    .insert(schema.categories)
    .values({ vendorId, parentId: parent?.id ?? null, name: input.name, slug, path: parent ? `${parent.path}/${slug}` : slug, sortOrder: input.sortOrder ?? 0 })
    .returning();
  return row!;
}

export async function updateCategory(tx: Tx, vendorId: string, id: string, input: { name?: string; slug?: string; parentId?: string | null; sortOrder?: number; version?: number }) {
  const before = await getCategory(tx, vendorId, id);
  if (input.version !== undefined && input.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });

  let parentPath: string | null | undefined;
  let parentId = before.parentId;
  if (input.parentId !== undefined) {
    if (input.parentId === id) throw new AppError('CONFLICT', 'A category cannot be its own parent');
    const parent = input.parentId ? await getCategory(tx, vendorId, input.parentId) : null;
    if (parent && (parent.path === before.path || parent.path.startsWith(`${before.path}/`))) throw new AppError('CONFLICT', 'A category cannot be moved under its own descendant');
    parentId = parent?.id ?? null;
    parentPath = parent?.path ?? null;
  } else if (before.parentId) {
    parentPath = (await getCategory(tx, vendorId, before.parentId)).path;
  }
  const slug = input.slug !== undefined ? slugify(input.slug, 60) : before.slug;
  const path = parentPath ? `${parentPath}/${slug}` : slug;

  const [after] = await tx
    .update(schema.categories)
    .set({ name: input.name ?? before.name, slug, parentId, path, sortOrder: input.sortOrder ?? before.sortOrder, version: sql`${schema.categories.version} + 1` })
    .where(eq(schema.categories.id, id))
    .returning();

  if (path !== before.path) {
    // re-root the whole subtree under the new path
    await tx
      .update(schema.categories)
      .set({ path: sql`${path} || substr(${schema.categories.path}, ${before.path.length + 1})` })
      .where(and(eq(schema.categories.vendorId, vendorId), like(schema.categories.path, `${escapeLike(before.path)}/%`), isNull(schema.categories.deletedAt)));
  }
  return { before, after: after! };
}

export async function deleteCategory(tx: Tx, vendorId: string, id: string) {
  const c = await getCategory(tx, vendorId, id);
  const [child] = await tx.select({ id: schema.categories.id }).from(schema.categories).where(and(live(vendorId), eq(schema.categories.parentId, id))).limit(1);
  if (child) throw new AppError('CONFLICT', 'Category has sub-categories; move or delete them first', { details: { rule: 'has_children' } });
  const [prod] = await tx.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.vendorId, vendorId), eq(schema.products.categoryId, id), isNull(schema.products.deletedAt))).limit(1);
  if (prod) throw new AppError('CONFLICT', 'Category still has products; reassign them first', { details: { rule: 'has_products' } });
  await tx.update(schema.categories).set({ deletedAt: new Date() }).where(eq(schema.categories.id, id));
  await tx.delete(schema.categoryAttributes).where(eq(schema.categoryAttributes.categoryId, id));
  return c;
}

export interface CategoryListInput { limit: number; cursor?: string; q?: string; parentId?: string; sort?: Array<{ field: string; direction: 'asc' | 'desc' }> }

export async function listCategories(tx: Tx, vendorId: string, input: CategoryListInput) {
  const c = schema.categories;
  const ks = keyset<CategoryRow>({
    sorts: { createdAt: { column: c.createdAt, kind: 'timestamp' }, name: { column: c.name, kind: 'text' }, path: { column: c.path, kind: 'text' } },
    idColumn: c.id,
    sort: input.sort,
    defaultSort: { field: 'path', direction: 'asc' },
    cursor: input.cursor,
    limit: input.limit,
  });
  const parentFilter: SQL | undefined = input.parentId === undefined ? undefined : input.parentId === 'root' ? isNull(c.parentId) : eq(c.parentId, input.parentId);
  const search: SQL | undefined = input.q ? or(ilike(c.name, `%${escapeLike(input.q)}%`), ilike(c.slug, `%${escapeLike(input.q)}%`)) : undefined;
  const rows = await tx.select().from(c).where(and(live(vendorId), parentFilter, search, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  const field = input.sort?.[0]?.field ?? 'path';
  const page = ks.finish(rows, (r) => ({ sortValue: field === 'name' ? r.name : field === 'createdAt' ? r.createdAt : r.path, id: r.id }));
  return { items: page.items.map(toCategoryDto), nextCursor: page.nextCursor };
}

export interface CategoryNode extends ReturnType<typeof toCategoryDto> { children: CategoryNode[] }

export async function categoryTree(tx: Tx, vendorId: string): Promise<CategoryNode[]> {
  const rows = await tx.select().from(schema.categories).where(live(vendorId)).orderBy(schema.categories.sortOrder, schema.categories.name).limit(5000);
  const nodes = new Map<string, CategoryNode>(rows.map((r) => [r.id, { ...toCategoryDto(r), children: [] }]));
  const roots: CategoryNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  return roots;
}
