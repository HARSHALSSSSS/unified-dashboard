import { and, desc, eq, inArray, lt, or, schema, sql, withSystem, withVendor, type Tx } from '@oms/database';
import { AppError, Errors, newId } from '@oms/shared';
import { getVariantRow, updateVariant } from '@oms/mod-catalog';
import { requestPriceSync, setListingPrice } from '@oms/mod-listings';
import { evaluate, liveRules, recordExecutions } from '@oms/mod-rules';
import { effects, type Container, type OpCtx } from '@oms/module-kit';
import { applyChange, computePrice, effectivePrice, saleActive, type Change, type PriceResult } from './domain';

const MP = schema.marketplacePrices;
const PH = schema.priceHistory;
const V = schema.productVariants;
const A = schema.marketplaceAccounts;
export type MarketplacePriceRow = typeof MP.$inferSelect;
type Field = (typeof schema.PRICE_FIELDS)[number];
type Source = (typeof schema.PRICE_SOURCES)[number];

export const toPriceDto = (r: MarketplacePriceRow, now = new Date()) => ({
  id: r.id, variantId: r.variantId, marketplaceAccountId: r.marketplaceAccountId, priceMinor: r.priceMinor, mrpMinor: r.mrpMinor,
  sale: { priceMinor: r.salePriceMinor, startsAt: r.saleStartsAt ? r.saleStartsAt.toISOString() : null, endsAt: r.saleEndsAt ? r.saleEndsAt.toISOString() : null, active: saleActive(r, now) },
  effectivePriceMinor: effectivePrice(r, now), appliedPriceMinor: r.appliedPriceMinor, appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null, source: r.source as Source, version: r.version, updatedAt: r.updatedAt.toISOString(),
});

/** Marketplace price pushes to ask for AFTER the transaction commits (a queued job must not start before the data exists). */
export class SyncWork {
  private readonly by = new Map<string, Set<string>>();
  add(accountId: string, listingIds: string[]): void { const s = this.by.get(accountId) ?? new Set(); listingIds.forEach((i) => s.add(i)); this.by.set(accountId, s); }
  get size(): number { return this.by.size; }
  /** only marketplaces whose connector can take prices get a job */
  async flush(c: Container, vendorId: string): Promise<Array<{ accountId: string; skipped?: string }>> {
    const out: Array<{ accountId: string; skipped?: string }> = [];
    for (const [accountId, ids] of this.by) {
      const acc = await withVendor(c.database.db, vendorId, async (tx) => (await tx.select({ m: A.marketplace }).from(A).where(and(eq(A.id, accountId), eq(A.vendorId, vendorId))))[0]);
      const supported = acc ? c.connectors.get(acc.m).capabilities.pricing.push : false;
      if (!supported) { out.push({ accountId, skipped: 'connector_cannot_push_prices' }); continue; }
      await requestPriceSync(c, vendorId, accountId, [...ids]);
      out.push({ accountId });
    }
    this.by.clear();
    return out;
  }
}

// ------------------------------------------------------------------------------------------------
// history
// ------------------------------------------------------------------------------------------------
async function history(tx: Tx, vendorId: string, h: { variantId: string; accountId?: string | null; field: Field; oldMinor: number | null; newMinor: number | null; source: Source; ruleId?: string | null; batchId?: string | null; reason?: string | null; actorId?: string | null }): Promise<void> {
  if (h.oldMinor === h.newMinor) return;
  await tx.insert(PH).values({ vendorId, variantId: h.variantId, marketplaceAccountId: h.accountId ?? null, field: h.field, oldPriceMinor: h.oldMinor, newPriceMinor: h.newMinor, source: h.source, ruleId: h.ruleId ?? null, batchId: h.batchId ?? null, reason: h.reason ?? null, actorId: h.actorId ?? null });
}
export async function listHistory(tx: Tx, vendorId: string, q: { variantId?: string; accountId?: string; batchId?: string; field?: string; before?: number; limit: number }) {
  const rows = await tx.select().from(PH).where(and(eq(PH.vendorId, vendorId), q.variantId ? eq(PH.variantId, q.variantId) : undefined, q.accountId ? eq(PH.marketplaceAccountId, q.accountId) : undefined, q.batchId ? eq(PH.batchId, q.batchId) : undefined, q.field ? eq(PH.field, q.field) : undefined, q.before ? lt(PH.id, q.before) : undefined)).orderBy(desc(PH.id)).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: page.map((h) => ({ id: h.id, variantId: h.variantId, marketplaceAccountId: h.marketplaceAccountId, field: h.field as Field, oldPriceMinor: h.oldPriceMinor, newPriceMinor: h.newPriceMinor, source: h.source as Source, ruleId: h.ruleId, batchId: h.batchId, reason: h.reason, actorId: h.actorId, createdAt: h.createdAt.toISOString() })), nextBefore: rows.length > q.limit ? page[page.length - 1]!.id : null };
}

// ------------------------------------------------------------------------------------------------
// reads
// ------------------------------------------------------------------------------------------------
export async function variantPricing(tx: Tx, vendorId: string, variantId: string) {
  const v = await getVariantRow(tx, vendorId, variantId);
  const rows = await tx.select().from(MP).where(and(eq(MP.vendorId, vendorId), eq(MP.variantId, variantId))).orderBy(MP.createdAt);
  const now = new Date();
  return { variantId, sku: v.sku, currency: v.currency.trim(), baseMinor: v.sellingPriceMinor, mrpMinor: v.mrpMinor, costMinor: v.costPriceMinor, marketplacePrices: rows.map((r) => toPriceDto(r, now)) };
}
export async function listPrices(tx: Tx, vendorId: string, q: { accountId?: string; variantId?: string; saleOnly?: boolean; limit: number; after?: string }) {
  const rows = await tx.select().from(MP).where(and(eq(MP.vendorId, vendorId), q.accountId ? eq(MP.marketplaceAccountId, q.accountId) : undefined, q.variantId ? eq(MP.variantId, q.variantId) : undefined, q.saleOnly ? sql`${MP.salePriceMinor} IS NOT NULL` : undefined, q.after ? sql`${MP.id} > ${q.after}` : undefined)).orderBy(MP.id).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: page.map((r) => toPriceDto(r)), nextAfter: rows.length > q.limit ? page[page.length - 1]!.id : null };
}

// ------------------------------------------------------------------------------------------------
// set / clear one marketplace price
// ------------------------------------------------------------------------------------------------
export interface PriceInput {
  variantId: string; accountId: string; priceMinor?: number | null; mrpMinor?: number | null; salePriceMinor?: number | null; saleStartsAt?: Date | null; saleEndsAt?: Date | null;
  source?: Source; reason?: string | null; ruleId?: string | null; batchId?: string | null;
}

/** Validate against the variant and the marketplace MRP: no price above MRP, no sale above the regular price. */
function validate(v: { sellingPriceMinor: number | null; mrpMinor: number | null; sku: string }, next: { price: number | null; mrp: number | null; sale: number | null; starts: Date | null; ends: Date | null }): void {
  const mrp = next.mrp ?? v.mrpMinor;
  const regular = next.price ?? v.sellingPriceMinor;
  if (mrp !== null && next.price !== null && next.price > mrp) throw new AppError('BAD_REQUEST', 'The price cannot be higher than the MRP', { details: { rule: 'price_above_mrp', sku: v.sku, priceMinor: next.price, mrpMinor: mrp } });
  if (next.sale !== null && regular !== null && next.sale > regular) throw new AppError('BAD_REQUEST', 'The sale price cannot be higher than the regular price', { details: { rule: 'sale_above_price', sku: v.sku, salePriceMinor: next.sale, regularMinor: regular } });
  if (next.starts && next.ends && next.ends <= next.starts) throw new AppError('BAD_REQUEST', 'The sale must end after it starts', { details: { rule: 'sale_window' } });
  if (next.sale === null && (next.starts || next.ends)) throw new AppError('BAD_REQUEST', 'A sale window needs a sale price', { details: { rule: 'sale_window_without_price' } });
}

export async function setMarketplacePrice(tx: Tx, ctx: OpCtx, work: SyncWork, input: PriceInput): Promise<{ row: MarketplacePriceRow; changed: boolean }> {
  const [acct] = await tx.select({ id: A.id }).from(A).where(and(eq(A.id, input.accountId), eq(A.vendorId, ctx.vendorId)));
  if (!acct) throw Errors.notFound('Marketplace account', input.accountId);
  const v = await getVariantRow(tx, ctx.vendorId, input.variantId);
  const [cur] = await tx.select().from(MP).where(and(eq(MP.vendorId, ctx.vendorId), eq(MP.marketplaceAccountId, input.accountId), eq(MP.variantId, input.variantId)));
  const pick = <T>(n: T | undefined, c: T | null | undefined): T | null => (n !== undefined ? n : c ?? null) as T | null;
  const next = {
    price: pick(input.priceMinor, cur?.priceMinor), mrp: pick(input.mrpMinor, cur?.mrpMinor), sale: pick(input.salePriceMinor, cur?.salePriceMinor),
    starts: pick(input.saleStartsAt, cur?.saleStartsAt), ends: pick(input.saleEndsAt, cur?.saleEndsAt),
  };
  if (input.salePriceMinor === null) { next.starts = null; next.ends = null; } // clearing the sale clears its window
  validate(v, next);
  const source = input.source ?? 'manual';
  const values = { priceMinor: next.price, mrpMinor: next.mrp, salePriceMinor: next.sale, saleStartsAt: next.starts, saleEndsAt: next.ends, source };
  const [row] = cur
    ? await tx.update(MP).set({ ...values, version: sql`${MP.version} + 1` }).where(eq(MP.id, cur.id)).returning()
    : await tx.insert(MP).values({ vendorId: ctx.vendorId, variantId: input.variantId, marketplaceAccountId: input.accountId, ...values }).returning();
  const h = { variantId: input.variantId, accountId: input.accountId, source, ruleId: input.ruleId, batchId: input.batchId, reason: input.reason, actorId: ctx.actor.id };
  await history(tx, ctx.vendorId, { ...h, field: 'marketplace', oldMinor: cur?.priceMinor ?? null, newMinor: next.price });
  await history(tx, ctx.vendorId, { ...h, field: 'mrp', oldMinor: cur?.mrpMinor ?? null, newMinor: next.mrp });
  await history(tx, ctx.vendorId, { ...h, field: 'sale', oldMinor: cur?.salePriceMinor ?? null, newMinor: next.sale });
  const changed = await reconcile(tx, ctx, work, row!, v.sku);
  const fx = effects(tx, ctx);
  if (!cur || cur.priceMinor !== next.price || cur.salePriceMinor !== next.sale || cur.mrpMinor !== next.mrp) {
    await fx.event({ type: 'pricing.changed', aggregateType: 'variant', aggregateId: input.variantId, payload: { sku: v.sku, accountId: input.accountId, priceMinor: next.price, salePriceMinor: next.sale, mrpMinor: next.mrp, source } });
    await fx.audit({ action: 'pricing.set', resourceType: 'variant', resourceId: input.variantId, before: cur ? { priceMinor: cur.priceMinor, salePriceMinor: cur.salePriceMinor, mrpMinor: cur.mrpMinor } : null, after: { accountId: input.accountId, priceMinor: next.price, salePriceMinor: next.sale, mrpMinor: next.mrp, source, reason: input.reason ?? null } });
  }
  return { row: (await tx.select().from(MP).where(eq(MP.id, row!.id)))[0]!, changed };
}

/**
 * Bring the listing in line with what the price row says right now (sale price while a sale runs, else the marketplace price,
 * else "follow the variant"). Exactly-once: it only touches the listing when the effective price differs from what was last applied.
 */
export async function reconcile(tx: Tx, ctx: OpCtx, work: SyncWork, row: MarketplacePriceRow, sku: string, now = new Date()): Promise<boolean> {
  const effective = effectivePrice(row, now);
  if (effective === row.appliedPriceMinor && row.appliedAt) return false;
  const listings = await setListingPrice(tx, ctx.vendorId, row.variantId, row.marketplaceAccountId, { priceMinor: effective, mrpMinor: row.mrpMinor });
  const wasSale = row.appliedPriceMinor !== null && row.salePriceMinor !== null && row.appliedPriceMinor === row.salePriceMinor;
  await tx.update(MP).set({ appliedPriceMinor: effective, appliedAt: now }).where(eq(MP.id, row.id));
  if (listings.length) work.add(row.marketplaceAccountId, listings.map((l) => l.id));
  const nowSale = saleActive(row, now) && effective === row.salePriceMinor;
  const fx = effects(tx, ctx);
  if (nowSale && !wasSale) await fx.event({ type: 'pricing.sale_started', aggregateType: 'variant', aggregateId: row.variantId, payload: { sku, accountId: row.marketplaceAccountId, salePriceMinor: row.salePriceMinor } });
  if (!nowSale && wasSale) await fx.event({ type: 'pricing.sale_ended', aggregateType: 'variant', aggregateId: row.variantId, payload: { sku, accountId: row.marketplaceAccountId, priceMinor: effective } });
  return true;
}

/** remove the marketplace-specific price: the listing follows the variant's own price again */
export async function clearMarketplacePrice(tx: Tx, ctx: OpCtx, work: SyncWork, id: string): Promise<void> {
  const [row] = await tx.select().from(MP).where(and(eq(MP.id, id), eq(MP.vendorId, ctx.vendorId)));
  if (!row) throw Errors.notFound('Marketplace price', id);
  const listings = await setListingPrice(tx, ctx.vendorId, row.variantId, row.marketplaceAccountId, { priceMinor: null });
  if (listings.length) work.add(row.marketplaceAccountId, listings.map((l) => l.id));
  await tx.delete(MP).where(eq(MP.id, id));
  const h = { variantId: row.variantId, accountId: row.marketplaceAccountId, source: 'manual' as Source, actorId: ctx.actor.id, reason: 'marketplace price removed' };
  await history(tx, ctx.vendorId, { ...h, field: 'marketplace', oldMinor: row.priceMinor, newMinor: null });
  await history(tx, ctx.vendorId, { ...h, field: 'sale', oldMinor: row.salePriceMinor, newMinor: null });
  await effects(tx, ctx).audit({ action: 'pricing.cleared', resourceType: 'variant', resourceId: row.variantId, before: { accountId: row.marketplaceAccountId, priceMinor: row.priceMinor, salePriceMinor: row.salePriceMinor } });
}

// ------------------------------------------------------------------------------------------------
// bulk updates
// ------------------------------------------------------------------------------------------------
export interface BulkInput { field: 'base' | 'marketplace'; accountId?: string; variantIds?: string[]; change: Change; dryRun: boolean; reason?: string | null }
export interface BulkItem { variantId: string; sku: string; accountId: string | null; field: 'base' | 'marketplace'; oldMinor: number | null; newMinor: number | null; status: 'changed' | 'unchanged' | 'skipped'; reason?: string }

async function targets(tx: Tx, vendorId: string, input: { accountId?: string; variantIds?: string[] }) {
  const L = schema.marketplaceListings;
  if (input.variantIds?.length) return tx.select().from(V).where(and(eq(V.vendorId, vendorId), inArray(V.id, input.variantIds))).limit(1000);
  if (!input.accountId) throw new AppError('BAD_REQUEST', 'Give variantIds or an accountId to select what to change');
  const rows = await tx.select({ v: V }).from(V).innerJoin(L, and(eq(L.variantId, V.id), eq(L.vendorId, V.vendorId))).where(and(eq(V.vendorId, vendorId), eq(L.marketplaceAccountId, input.accountId))).limit(2000);
  return [...new Map(rows.map((r) => [r.v.id, r.v])).values()].slice(0, 1000);
}

/** Change many prices at once (set / % / amount). `dryRun` shows exactly what would change; a real run is one batch with one batchId in the history. */
export async function bulkUpdate(ctx: OpCtx, work: SyncWork, input: BulkInput): Promise<{ batchId: string | null; dryRun: boolean; total: number; changed: number; unchanged: number; skipped: number; items: BulkItem[] }> {
  if (input.field === 'marketplace' && !input.accountId) throw new AppError('BAD_REQUEST', 'A marketplace price change needs an accountId');
  return withVendor(ctx.c.database.db, ctx.vendorId, async (tx) => {
    const vars = await targets(tx, ctx.vendorId, input);
    const batchId = input.dryRun ? null : `bulk_${newId()}`;
    const existing = input.field === 'marketplace' ? await tx.select().from(MP).where(and(eq(MP.vendorId, ctx.vendorId), eq(MP.marketplaceAccountId, input.accountId!), inArray(MP.variantId, vars.map((v) => v.id)))) : [];
    const items: BulkItem[] = [];
    const fx = effects(tx, ctx);
    for (const v of vars) {
      const cur = input.field === 'base' ? v.sellingPriceMinor : (existing.find((e) => e.variantId === v.id)?.priceMinor ?? v.sellingPriceMinor);
      const item: BulkItem = { variantId: v.id, sku: v.sku, accountId: input.accountId ?? null, field: input.field, oldMinor: cur, newMinor: null, status: 'skipped' };
      if (cur === null) { items.push({ ...item, reason: 'no current price to change' }); continue; }
      const next = applyChange(cur, input.change);
      item.newMinor = next;
      if (next === cur) { items.push({ ...item, status: 'unchanged' }); continue; }
      if (v.mrpMinor !== null && next > v.mrpMinor) { items.push({ ...item, reason: `above MRP (${v.mrpMinor})` }); continue; }
      if (!input.dryRun) {
        try {
          // a failing line must not poison the batch (a savepoint keeps the rest of the transaction usable)
          await tx.transaction(async (sp) => {
            if (input.field === 'base') {
              await updateVariant(sp, ctx.vendorId, v.id, { sellingPriceMinor: next }, fx);
              await history(sp, ctx.vendorId, { variantId: v.id, field: 'base', oldMinor: cur, newMinor: next, source: 'bulk', batchId, reason: input.reason, actorId: ctx.actor.id });
            } else await setMarketplacePrice(sp, ctx, work, { variantId: v.id, accountId: input.accountId!, priceMinor: next, source: 'bulk', batchId, reason: input.reason });
          });
        } catch (e) { items.push({ ...item, reason: e instanceof AppError ? e.message : 'failed' }); continue; }
      }
      items.push({ ...item, status: 'changed' });
    }
    if (!input.dryRun) await fx.audit({ action: 'pricing.bulk', resourceType: 'pricing_batch', resourceId: batchId!, after: { field: input.field, change: input.change, changed: items.filter((i) => i.status === 'changed').length, accountId: input.accountId ?? null } });
    return { batchId, dryRun: input.dryRun, total: items.length, changed: items.filter((i) => i.status === 'changed').length, unchanged: items.filter((i) => i.status === 'unchanged').length, skipped: items.filter((i) => i.status === 'skipped').length, items: items.slice(0, 500) };
  });
}

// ------------------------------------------------------------------------------------------------
// rule-driven prices
// ------------------------------------------------------------------------------------------------
export interface RuleItem { variantId: string; sku: string; baseMinor: number; oldMinor: number | null; newMinor: number | null; ruleIds: string[]; steps: string[]; status: 'changed' | 'unchanged' | 'no_rule' | 'skipped'; belowMargin?: boolean; reason?: string }

/**
 * Price the account's variants from the vendor's pricing rules (base price + matching rules). `dryRun` previews with the steps
 * taken; a real run stores `source: rule` prices (so a later base-price change re-prices them automatically).
 */
export async function applyRules(ctx: OpCtx, work: SyncWork, input: { accountId: string; variantIds?: string[]; dryRun: boolean }): Promise<{ dryRun: boolean; total: number; changed: number; items: RuleItem[] }> {
  return withVendor(ctx.c.database.db, ctx.vendorId, async (tx) => {
    const [acct] = await tx.select().from(A).where(and(eq(A.id, input.accountId), eq(A.vendorId, ctx.vendorId)));
    if (!acct) throw Errors.notFound('Marketplace account', input.accountId);
    const vars = await targets(tx, ctx.vendorId, input);
    const products = vars.length ? await tx.select().from(schema.products).where(and(eq(schema.products.vendorId, ctx.vendorId), inArray(schema.products.id, [...new Set(vars.map((v) => v.productId))]))) : [];
    const rules = await liveRules(tx, ctx.vendorId, 'pricing');
    const existing = vars.length ? await tx.select().from(MP).where(and(eq(MP.vendorId, ctx.vendorId), eq(MP.marketplaceAccountId, input.accountId), inArray(MP.variantId, vars.map((v) => v.id)))) : [];
    const items: RuleItem[] = [];
    for (const v of vars) {
      const old = existing.find((e) => e.variantId === v.id)?.priceMinor ?? null;
      const base = { variantId: v.id, sku: v.sku, baseMinor: v.sellingPriceMinor ?? 0, oldMinor: old, newMinor: null as number | null, ruleIds: [] as string[], steps: [] as string[] };
      if (v.sellingPriceMinor === null) { items.push({ ...base, status: 'skipped', reason: 'the variant has no base price' }); continue; }
      const pr = products.find((p) => p.id === v.productId);
      const matched = evaluate(rules, { marketplace: acct.marketplace, accountId: acct.id, categoryId: pr?.categoryId ?? null, brand: pr?.brand ?? null, sku: v.sku, tags: pr?.tags ?? [], basePriceMinor: v.sellingPriceMinor, costMinor: v.costPriceMinor, mrpMinor: v.mrpMinor });
      if (matched.length === 0) { items.push({ ...base, status: 'no_rule' }); continue; }
      const res: PriceResult = computePrice({ baseMinor: v.sellingPriceMinor, mrpMinor: v.mrpMinor, costMinor: v.costPriceMinor }, matched.map((m) => m.action));
      const out: RuleItem = { ...base, newMinor: res.priceMinor, ruleIds: matched.map((m) => m.rule.id), steps: res.steps, belowMargin: res.belowMargin, status: res.priceMinor === old ? 'unchanged' : 'changed' };
      if (out.status === 'changed' && !input.dryRun) {
        await setMarketplacePrice(tx, ctx, work, { variantId: v.id, accountId: input.accountId, priceMinor: res.priceMinor, source: 'rule', ruleId: matched[0]!.rule.id, reason: `rules: ${matched.map((m) => m.rule.name).join(', ')}` });
        await recordExecutions(tx, ctx.vendorId, 'pricing', 'variant', v.id, matched.map((m) => ({ ruleId: m.rule.id, outcome: { accountId: input.accountId, priceMinor: res.priceMinor } })));
      }
      items.push(out);
    }
    return { dryRun: input.dryRun, total: items.length, changed: items.filter((i) => i.status === 'changed').length, items: items.slice(0, 500) };
  });
}

// ------------------------------------------------------------------------------------------------
// scheduled sales + base-price reactions
// ------------------------------------------------------------------------------------------------
/** Start sales whose window opened and end those whose window closed (each exactly once). Safe to run every minute. */
export async function processSales(c: Container, now = new Date()): Promise<{ started: number; ended: number }> {
  const due = await withSystem(c.database.db, (tx) => tx.select({ id: MP.id, vendorId: MP.vendorId }).from(MP).where(and(
    sql`${MP.salePriceMinor} IS NOT NULL`,
    or(
      and(sql`(${MP.saleStartsAt} IS NULL OR ${MP.saleStartsAt} <= ${now})`, sql`(${MP.saleEndsAt} IS NULL OR ${MP.saleEndsAt} > ${now})`, sql`${MP.appliedPriceMinor} IS DISTINCT FROM ${MP.salePriceMinor}`),
      and(sql`${MP.saleEndsAt} <= ${now}`, sql`${MP.appliedPriceMinor} IS NOT DISTINCT FROM ${MP.salePriceMinor}`),
    ),
  )).limit(500));
  let started = 0;
  let ended = 0;
  const byVendor = new Map<string, string[]>();
  for (const d of due) byVendor.set(d.vendorId, [...(byVendor.get(d.vendorId) ?? []), d.id]);
  for (const [vendorId, ids] of byVendor) {
    const ctx: OpCtx = { c, vendorId, actor: { type: 'system', id: 'pricing-sales' } };
    const work = new SyncWork();
    await withVendor(c.database.db, vendorId, async (tx) => {
      for (const id of ids) {
        const [row] = await tx.select().from(MP).where(eq(MP.id, id)).for('update', { skipLocked: true }); // a second scheduler run skips rows the first one holds
        if (!row) continue;
        const [v] = await tx.select({ sku: V.sku }).from(V).where(eq(V.id, row.variantId));
        const wasSale = row.appliedPriceMinor !== null && row.appliedPriceMinor === row.salePriceMinor;
        if (await reconcile(tx, ctx, work, row, v?.sku ?? '', now)) {
          await history(tx, vendorId, { variantId: row.variantId, accountId: row.marketplaceAccountId, field: 'sale', oldMinor: wasSale ? row.salePriceMinor : null, newMinor: wasSale ? null : row.salePriceMinor, source: 'schedule', reason: wasSale ? 'sale ended' : 'sale started' });
          if (wasSale) ended++; else started++;
        }
      }
    });
    await work.flush(c, vendorId);
  }
  return { started, ended };
}

/** The variant's own price changed: record it, and re-price the marketplace prices that are derived from it by rules. */
export async function onBasePriceChanged(c: Container, vendorId: string, variantId: string, price: { before: { sellingPriceMinor: number | null; mrpMinor: number | null }; after: { sellingPriceMinor: number | null; mrpMinor: number | null } }): Promise<void> {
  const ctx: OpCtx = { c, vendorId, actor: { type: 'system', id: 'pricing-base-change' } };
  const work = new SyncWork();
  const accounts = await withVendor(c.database.db, vendorId, async (tx) => {
    const [last] = await tx.select().from(PH).where(and(eq(PH.vendorId, vendorId), eq(PH.variantId, variantId), eq(PH.field, 'base'))).orderBy(desc(PH.id)).limit(1);
    if (!last || last.newPriceMinor !== price.after.sellingPriceMinor) await history(tx, vendorId, { variantId, field: 'base', oldMinor: price.before.sellingPriceMinor, newMinor: price.after.sellingPriceMinor, source: 'catalog' });
    const [lastMrp] = await tx.select().from(PH).where(and(eq(PH.vendorId, vendorId), eq(PH.variantId, variantId), eq(PH.field, 'mrp'), sql`${PH.marketplaceAccountId} IS NULL`)).orderBy(desc(PH.id)).limit(1);
    if (!lastMrp || lastMrp.newPriceMinor !== price.after.mrpMinor) await history(tx, vendorId, { variantId, field: 'mrp', oldMinor: price.before.mrpMinor, newMinor: price.after.mrpMinor, source: 'catalog' });
    return (await tx.select({ a: MP.marketplaceAccountId }).from(MP).where(and(eq(MP.vendorId, vendorId), eq(MP.variantId, variantId), eq(MP.source, 'rule')))).map((r) => r.a);
  });
  for (const accountId of accounts) await applyRules(ctx, work, { accountId, variantIds: [variantId], dryRun: false }).catch((e) => c.logger.warn({ variantId, accountId, err: (e as Error).message }, 're-pricing after a base price change failed'));
  await work.flush(c, vendorId);
}
