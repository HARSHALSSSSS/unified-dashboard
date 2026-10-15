import { and, asc, eq, schema, sql, type Tx } from '@oms/database';
import { requireCapability, type ListingRequirement, type MarketplaceCategory } from '@oms/marketplace-core';
import { AppError, Errors } from '@oms/shared';
import { ConnectorHost } from '@oms/mod-marketplace-connectors';
import type { Container } from '@oms/module-kit';
import { CORE_FIELDS } from './context';

const CM = schema.categoryMappings;
const AM = schema.attributeMappings;

// ------------------------------------------------------------------------------------------------
// marketplace taxonomy (read-through, short in-process cache: category trees change rarely)
// ------------------------------------------------------------------------------------------------
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 5 * 60_000;
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearTaxonomyCache = (): void => cache.clear();

export async function searchMarketplaceCategories(c: Container, vendorId: string, accountId: string, query?: string): Promise<MarketplaceCategory[]> {
  return new ConnectorHost(c).run(vendorId, accountId, async (connector, ctx) => {
    requireCapability(connector, 'listings.categorySearch');
    return cached(`cat:${ctx.marketplaceAccountId}:${query ?? ''}`, () => connector.searchCategories!(ctx, { query }));
  });
}

/** What the marketplace category demands (empty when the connector does not publish requirements). */
export async function categoryRequirements(c: Container, vendorId: string, accountId: string, marketplaceCategoryId: string): Promise<ListingRequirement[]> {
  return new ConnectorHost(c).run(vendorId, accountId, async (connector, ctx) => {
    if (!connector.getCategoryRequirements) return [];
    return cached(`req:${connector.code}:${marketplaceCategoryId}`, () => connector.getCategoryRequirements!(ctx, { marketplaceCategoryId }));
  });
}

// ------------------------------------------------------------------------------------------------
// category mappings: our category -> marketplace category
// ------------------------------------------------------------------------------------------------
export type CategoryMappingRow = typeof CM.$inferSelect;
export const toCategoryMappingDto = (m: CategoryMappingRow) => ({
  id: m.id, marketplace: m.marketplace, categoryId: m.categoryId, marketplaceCategoryId: m.marketplaceCategoryId, marketplaceCategoryName: m.marketplaceCategoryName, marketplaceCategoryPath: m.marketplaceCategoryPath,
  version: m.version, createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(),
});

export async function upsertCategoryMapping(c: Container, tx: Tx, vendorId: string, input: { marketplace: string; categoryId: string; marketplaceCategoryId: string; marketplaceCategoryName?: string | null; marketplaceCategoryPath?: string | null }) {
  c.connectors.get(input.marketplace); // 404 for unknown marketplaces
  const [cat] = await tx.select({ id: schema.categories.id }).from(schema.categories).where(and(eq(schema.categories.id, input.categoryId), eq(schema.categories.vendorId, vendorId), sql`${schema.categories.deletedAt} IS NULL`));
  if (!cat) throw Errors.notFound('Category', input.categoryId);
  const [row] = await tx
    .insert(CM)
    .values({ vendorId, marketplace: input.marketplace, categoryId: input.categoryId, marketplaceCategoryId: input.marketplaceCategoryId, marketplaceCategoryName: input.marketplaceCategoryName ?? null, marketplaceCategoryPath: input.marketplaceCategoryPath ?? null })
    .onConflictDoUpdate({
      target: [CM.vendorId, CM.marketplace, CM.categoryId],
      set: { marketplaceCategoryId: input.marketplaceCategoryId, marketplaceCategoryName: input.marketplaceCategoryName ?? null, marketplaceCategoryPath: input.marketplaceCategoryPath ?? null, version: sql`${CM.version} + 1` },
    })
    .returning();
  return row!;
}

export async function listCategoryMappings(tx: Tx, vendorId: string, marketplace?: string) {
  return tx.select().from(CM).where(and(eq(CM.vendorId, vendorId), marketplace ? eq(CM.marketplace, marketplace) : undefined)).orderBy(asc(CM.marketplace), asc(CM.createdAt));
}

export async function deleteCategoryMapping(tx: Tx, vendorId: string, id: string) {
  const [row] = await tx.delete(CM).where(and(eq(CM.id, id), eq(CM.vendorId, vendorId))).returning();
  if (!row) throw Errors.notFound('Category mapping', id);
  return row;
}

// ------------------------------------------------------------------------------------------------
// attribute mappings: marketplace attribute <- core field | vendor attribute | static value
// ------------------------------------------------------------------------------------------------
export type AttributeMappingRow = typeof AM.$inferSelect;
export const toAttributeMappingDto = (m: AttributeMappingRow) => ({
  id: m.id, marketplace: m.marketplace, marketplaceCategoryId: m.marketplaceCategoryId, marketplaceAttribute: m.marketplaceAttribute,
  sourceType: m.sourceType as 'core_field' | 'attribute' | 'static', coreField: m.coreField, attributeId: m.attributeId, staticValue: m.staticValue, valueMap: m.valueMap as Record<string, string>,
  version: m.version, createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(),
});

export interface AttributeMappingInput {
  marketplace: string; marketplaceCategoryId: string; marketplaceAttribute: string;
  source: { type: 'core_field'; coreField: string } | { type: 'attribute'; attributeId: string } | { type: 'static'; value: string };
  valueMap?: Record<string, string>;
}

export async function upsertAttributeMapping(c: Container, tx: Tx, vendorId: string, input: AttributeMappingInput) {
  c.connectors.get(input.marketplace);
  const s = input.source;
  if (s.type === 'core_field' && !(CORE_FIELDS as readonly string[]).includes(s.coreField)) throw new AppError('VALIDATION_FAILED', 'Unknown core field', { details: { allowed: CORE_FIELDS, field: 'source.coreField' } });
  if (s.type === 'attribute') {
    const [a] = await tx.select({ id: schema.attributeDefinitions.id }).from(schema.attributeDefinitions).where(and(eq(schema.attributeDefinitions.id, s.attributeId), eq(schema.attributeDefinitions.vendorId, vendorId)));
    if (!a) throw Errors.notFound('Attribute', s.attributeId);
  }
  const cols = { sourceType: s.type, coreField: s.type === 'core_field' ? s.coreField : null, attributeId: s.type === 'attribute' ? s.attributeId : null, staticValue: s.type === 'static' ? s.value : null, valueMap: input.valueMap ?? {} };
  const [row] = await tx
    .insert(AM)
    .values({ vendorId, marketplace: input.marketplace, marketplaceCategoryId: input.marketplaceCategoryId, marketplaceAttribute: input.marketplaceAttribute, ...cols })
    .onConflictDoUpdate({ target: [AM.vendorId, AM.marketplace, AM.marketplaceCategoryId, AM.marketplaceAttribute], set: { ...cols, version: sql`${AM.version} + 1` } })
    .returning();
  return row!;
}

export async function listAttributeMappings(tx: Tx, vendorId: string, f: { marketplace?: string; marketplaceCategoryId?: string }) {
  return tx.select().from(AM).where(and(eq(AM.vendorId, vendorId), f.marketplace ? eq(AM.marketplace, f.marketplace) : undefined, f.marketplaceCategoryId ? eq(AM.marketplaceCategoryId, f.marketplaceCategoryId) : undefined)).orderBy(asc(AM.marketplaceAttribute));
}

export async function deleteAttributeMapping(tx: Tx, vendorId: string, id: string) {
  const [row] = await tx.delete(AM).where(and(eq(AM.id, id), eq(AM.vendorId, vendorId))).returning();
  if (!row) throw Errors.notFound('Attribute mapping', id);
  return row;
}

/** Proposed mapping for each requirement: an existing mapping, else a core field hint, else a vendor attribute with the same code/name. */
export async function suggestMappings(tx: Tx, vendorId: string, marketplace: string, marketplaceCategoryId: string, requirements: ListingRequirement[]) {
  const existing = new Map((await listAttributeMappings(tx, vendorId, { marketplace, marketplaceCategoryId })).map((m) => [m.marketplaceAttribute, m]));
  const attrs = await tx.select({ id: schema.attributeDefinitions.id, code: schema.attributeDefinitions.code, name: schema.attributeDefinitions.name }).from(schema.attributeDefinitions).where(eq(schema.attributeDefinitions.vendorId, vendorId));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return requirements.map((req) => {
    const have = existing.get(req.name);
    if (have) return { requirement: req, existing: toAttributeMappingDto(have), suggestion: null };
    if (req.coreField) return { requirement: req, existing: null, suggestion: { type: 'core_field' as const, coreField: req.coreField } };
    const match = attrs.find((a) => norm(a.code) === norm(req.name) || norm(a.name) === norm(req.name) || norm(a.name) === norm(req.label ?? ''));
    return { requirement: req, existing: null, suggestion: match ? { type: 'attribute' as const, attributeId: match.id, attributeCode: match.code } : null };
  });
}
