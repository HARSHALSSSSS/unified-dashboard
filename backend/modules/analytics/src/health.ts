import { sql, type Tx } from '@oms/database';
import { dailyUnits } from './queries';

const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
const rows = async (tx: Tx, q: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> => (await tx.execute<Record<string, unknown>>(q)).rows;
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const DAY = 86_400_000;

// ------------------------------------------------------------------------------------------------
// pure maths (unit tested)
// ------------------------------------------------------------------------------------------------
export interface StockLine { variantId: string; sku: string; title: string | null; onHand: number; reserved: number; reorderLevel: number | null; unitsSold: number; lastReceivedAt: Date | null }
export interface InventoryThresholds { windowDays: number; riskDays: number; excessDays: number; agingDays: number; slowUnitsPerDay: number; fastUnitsPerDay: number }
export const DEFAULT_THRESHOLDS: InventoryThresholds = { windowDays: 30, riskDays: 7, excessDays: 90, agingDays: 90, slowUnitsPerDay: 0.1, fastUnitsPerDay: 2 };

export type Flag = 'out_of_stock' | 'low_stock' | 'stockout_risk' | 'excess' | 'aging' | 'fast_moving' | 'slow_moving';
export interface InventoryFinding { variantId: string; sku: string; title: string | null; flags: Flag[]; available: number; onHand: number; reserved: number; reorderLevel: number | null; unitsPerDay: number; daysOfCover: number | null; stockoutDate: string | null; ageDays: number | null; suggestedReorderUnits: number | null }

/**
 * Classifies one stock line from REAL numbers only: available = on hand - reserved, velocity = units actually sold over the window.
 * `daysOfCover` is null when nothing sold (no velocity => no forecast, never a made-up one).
 */
export function classifyStock(l: StockLine, t: InventoryThresholds = DEFAULT_THRESHOLDS, now = new Date()): InventoryFinding {
  const available = l.onHand - l.reserved;
  const perDay = l.unitsSold / t.windowDays;
  const cover = perDay > 0 ? available / perDay : null;
  const ageDays = l.lastReceivedAt ? Math.floor((now.getTime() - l.lastReceivedAt.getTime()) / DAY) : null;
  const flags: Flag[] = [];
  if (available <= 0 && (perDay > 0 || l.reorderLevel !== null)) flags.push('out_of_stock');
  else if (l.reorderLevel !== null && available <= l.reorderLevel) flags.push('low_stock');
  if (available > 0 && cover !== null && cover < t.riskDays) flags.push('stockout_risk');
  if (available > 0 && ((cover !== null && cover > t.excessDays) || (perDay === 0 && available > 0 && ageDays !== null && ageDays > t.agingDays))) flags.push('excess');
  if (available > 0 && ageDays !== null && ageDays > t.agingDays && perDay < t.slowUnitsPerDay) flags.push('aging');
  if (perDay >= t.fastUnitsPerDay) flags.push('fast_moving');
  if (available > 0 && perDay < t.slowUnitsPerDay) flags.push('slow_moving');
  const target = perDay * 30; // thirty days of cover
  return {
    variantId: l.variantId, sku: l.sku, title: l.title, flags, available, onHand: l.onHand, reserved: l.reserved, reorderLevel: l.reorderLevel, unitsPerDay: Math.round(perDay * 100) / 100,
    daysOfCover: cover === null ? null : Math.round(cover * 10) / 10, stockoutDate: cover !== null && available > 0 ? new Date(now.getTime() + cover * DAY).toISOString().slice(0, 10) : null, ageDays,
    suggestedReorderUnits: perDay > 0 && (flags.includes('stockout_risk') || flags.includes('out_of_stock') || flags.includes('low_stock')) ? Math.max(0, Math.ceil(target - available)) : null,
  };
}

// ------------------------------------------------------------------------------------------------
// inventory health
// ------------------------------------------------------------------------------------------------
export async function stockLines(tx: Tx, vendorId: string, windowDays: number): Promise<StockLine[]> {
  const stock = await rows(tx, sql`select i.variant_id, v.sku, p.title, sum(i.quantity_on_hand)::int on_hand, sum(i.quantity_reserved)::int reserved, max(i.reorder_level)::int reorder
    from inventory i join product_variants v on v.id = i.variant_id and v.vendor_id = i.vendor_id join products p on p.id = v.product_id and p.vendor_id = v.vendor_id
    where i.vendor_id = ${vendorId} and v.deleted_at is null group by i.variant_id, v.sku, p.title limit 5000`);
  if (stock.length === 0) return [];
  const sold = await dailyUnits(tx, vendorId, windowDays);
  const ids = stock.map((s) => String(s.variant_id));
  const recv = await rows(tx, sql`select variant_id, max(created_at) at from inventory_movements where vendor_id = ${vendorId} and variant_id in (${inList(ids)}) and type in ('receive', 'incoming_receive', 'return_restock') group by 1`);
  return stock.map((s) => ({
    variantId: String(s.variant_id), sku: String(s.sku), title: s.title ? String(s.title) : null, onHand: n(s.on_hand), reserved: n(s.reserved), reorderLevel: s.reorder === null ? null : n(s.reorder),
    unitsSold: sold.get(String(s.variant_id)) ?? 0, lastReceivedAt: recv.find((r) => String(r.variant_id) === String(s.variant_id))?.at ? new Date(String(recv.find((r) => String(r.variant_id) === String(s.variant_id))!.at)) : null,
  }));
}

export async function inventoryHealth(tx: Tx, vendorId: string, t: InventoryThresholds = DEFAULT_THRESHOLDS, limit = 50) {
  const findings = (await stockLines(tx, vendorId, t.windowDays)).map((l) => classifyStock(l, t));
  const by = (f: Flag) => findings.filter((x) => x.flags.includes(f));
  const top = (f: Flag, cmp: (a: InventoryFinding, b: InventoryFinding) => number) => by(f).sort(cmp).slice(0, limit);
  return {
    thresholds: { ...t } as Record<string, number>, asOf: new Date().toISOString(), skusAnalysed: findings.length,
    counts: { outOfStock: by('out_of_stock').length, lowStock: by('low_stock').length, stockoutRisk: by('stockout_risk').length, excess: by('excess').length, aging: by('aging').length, fastMoving: by('fast_moving').length, slowMoving: by('slow_moving').length },
    outOfStock: top('out_of_stock', (a, b) => b.unitsPerDay - a.unitsPerDay), lowStock: top('low_stock', (a, b) => a.available - b.available),
    stockoutRisk: top('stockout_risk', (a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0)), excess: top('excess', (a, b) => b.available - a.available), aging: top('aging', (a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0)),
    fastMoving: top('fast_moving', (a, b) => b.unitsPerDay - a.unitsPerDay), slowMoving: top('slow_moving', (a, b) => b.available - a.available),
  };
}

// ------------------------------------------------------------------------------------------------
// product health: how complete / healthy is the catalogue and its marketplace presence
// ------------------------------------------------------------------------------------------------
const CHECKS: Array<{ code: string; weight: number; message: string }> = [
  { code: 'no_description', weight: 15, message: 'No description' }, { code: 'no_brand', weight: 10, message: 'No brand' }, { code: 'no_images', weight: 20, message: 'No images' },
  { code: 'no_category', weight: 10, message: 'No category' }, { code: 'no_hsn', weight: 5, message: 'No HSN code (needed for GST invoices on most marketplaces)' }, { code: 'no_barcode', weight: 5, message: 'No barcode' },
  { code: 'no_price', weight: 20, message: 'No selling price' }, { code: 'no_mrp', weight: 5, message: 'No MRP' }, { code: 'no_cost', weight: 5, message: 'No cost price (profitability cannot be calculated)' },
  { code: 'listing_issue', weight: 15, message: 'A marketplace listing is rejected or has errors' },
];

export async function productHealth(tx: Tx, vendorId: string, limit = 50) {
  const rs = await rows(tx, sql`select v.id variant_id, v.sku, p.id product_id, p.title,
      (coalesce(btrim(p.description), '') = '') no_description, (coalesce(btrim(p.brand), '') = '') no_brand, (p.category_id is null) no_category, (coalesce(btrim(p.hsn_code), '') = '') no_hsn,
      (coalesce(btrim(v.barcode), '') = '') no_barcode, (v.selling_price_minor is null) no_price, (v.mrp_minor is null) no_mrp, (v.cost_price_minor is null) no_cost,
      not exists (select 1 from product_documents d where d.vendor_id = p.vendor_id and d.product_id = p.id and d.kind = 'image' and d.status in ('uploaded','processed')) no_images,
      exists (select 1 from marketplace_listings l where l.vendor_id = v.vendor_id and l.variant_id = v.id and (l.status in ('rejected','correction_required') or jsonb_array_length(l.issues) > 0)) listing_issue
    from product_variants v join products p on p.id = v.product_id and p.vendor_id = v.vendor_id where v.vendor_id = ${vendorId} and v.deleted_at is null and p.deleted_at is null and p.status <> 'archived' limit 10000`);
  const scored = rs.map((r) => {
    const issues = CHECKS.filter((c) => r[c.code] === true);
    return { variantId: String(r.variant_id), productId: String(r.product_id), sku: String(r.sku), title: String(r.title), score: Math.max(0, 100 - issues.reduce((s, c) => s + c.weight, 0)), issues: issues.map((c) => ({ code: c.code, message: c.message })) };
  });
  const tally = Object.fromEntries(CHECKS.map((c) => [c.code, scored.filter((s) => s.issues.some((i) => i.code === c.code)).length]));
  const unmapped = n((await rows(tx, sql`select count(*)::int c from order_items i join orders o on o.id = i.order_id and o.vendor_id = i.vendor_id where i.vendor_id = ${vendorId} and i.variant_id is null and o.status not in ('cancelled','delivered','returned')`))[0]?.c);
  const idle = n((await rows(tx, sql`select count(distinct l.variant_id)::int c from marketplace_listings l join inventory i on i.variant_id = l.variant_id and i.vendor_id = l.vendor_id where l.vendor_id = ${vendorId} and l.status = 'active' group by l.vendor_id having sum(i.quantity_on_hand - i.quantity_reserved) <= 0`))[0]?.c);
  return {
    products: scored.length, averageScore: scored.length ? Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length) : null,
    complete: scored.filter((s) => s.score === 100).length, issueCounts: tally, openOrderLinesWithUnmappedSku: unmapped, activeListingsWithoutStock: idle,
    lowestScoring: scored.filter((s) => s.score < 100).sort((a, b) => a.score - b.score || a.sku.localeCompare(b.sku)).slice(0, limit),
  };
}

// ------------------------------------------------------------------------------------------------
// business health: where is the operation stuck?
// ------------------------------------------------------------------------------------------------
export interface HealthIssue { code: string; area: 'orders' | 'fulfillment' | 'shipping' | 'returns' | 'marketplace' | 'sync' | 'inventory'; severity: 'info' | 'warning' | 'critical'; count: number; message: string; sampleIds: string[] }
const WEIGHT = { info: 2, warning: 8, critical: 20 } as const;

/** score from the findings (pure): 100 minus capped penalties per issue */
export function healthScore(issues: Array<Pick<HealthIssue, 'severity' | 'count'>>): number {
  return Math.max(0, 100 - issues.reduce((s, i) => s + Math.min(30, WEIGHT[i.severity] + Math.floor(Math.log2(Math.max(1, i.count)) * 2)), 0));
}

export async function businessHealth(tx: Tx, vendorId: string) {
  const issues: HealthIssue[] = [];
  const add = async (code: string, area: HealthIssue['area'], severity: HealthIssue['severity'], message: string, q: ReturnType<typeof sql>) => {
    const r = await rows(tx, q);
    const count = r.length ? n(r[0]!.c) : 0;
    if (count > 0) issues.push({ code, area, severity, count, message, sampleIds: ((r[0]!.ids as string[] | null) ?? []).slice(0, 5).map(String) });
  };
  await add('orders_not_started', 'orders', 'warning', 'Orders waiting more than 24 hours with no warehouse work started', sql`select count(*)::int c, (array_agg(o.id order by o.placed_at))[1:5] ids from orders o where o.vendor_id = ${vendorId} and o.status in ('new','confirmed') and o.placed_at < now() - interval '24 hours' and not exists (select 1 from fulfillments f where f.order_id = o.id and f.vendor_id = o.vendor_id and f.status <> 'cancelled')`);
  await add('orders_need_attention', 'orders', 'warning', 'Orders flagged for attention (unmapped SKU, short stock, short pick)', sql`select count(*)::int c, (array_agg(o.id))[1:5] ids from orders o where o.vendor_id = ${vendorId} and o.attention_reason is not null and o.status not in ('cancelled','delivered','returned')`);
  await add('orders_short_stock', 'inventory', 'critical', 'Open orders that could not be fully reserved (backorders)', sql`select count(*)::int c, (array_agg(o.id))[1:5] ids from orders o where o.vendor_id = ${vendorId} and o.inventory_status in ('partial','unallocated') and o.status in ('new','confirmed','picking','packed','ready_to_dispatch')`);
  await add('fulfillment_stuck', 'fulfillment', 'warning', 'Fulfillments that have not moved for more than 24 hours before shipping', sql`select count(*)::int c, (array_agg(f.id))[1:5] ids from fulfillments f where f.vendor_id = ${vendorId} and f.status in ('confirmed','picking','picked','packing','packed','ready_to_ship') and f.updated_at < now() - interval '24 hours'`);
  await add('fulfillment_exceptions_open', 'fulfillment', 'warning', 'Open warehouse exceptions (short picks, damaged / wrong items)', sql`select count(*)::int c, (array_agg(e.id))[1:5] ids from fulfillment_exceptions e where e.vendor_id = ${vendorId} and e.status = 'open'`);
  await add('shipments_overdue', 'shipping', 'warning', 'Shipments dispatched more than 7 days ago and still not delivered', sql`select count(*)::int c, (array_agg(s.id))[1:5] ids from shipments s where s.vendor_id = ${vendorId} and s.status in ('dispatched','in_transit','out_for_delivery') and s.dispatched_at < now() - interval '7 days'`);
  await add('ndr_open', 'shipping', 'warning', 'Failed deliveries (NDR) waiting for a decision', sql`select count(*)::int c, (array_agg(n.id))[1:5] ids from ndr_cases n where n.vendor_id = ${vendorId} and n.status = 'open'`);
  await add('returns_awaiting_inspection', 'returns', 'warning', 'Returns received more than 3 days ago and not inspected', sql`select count(*)::int c, (array_agg(r.id))[1:5] ids from return_orders r where r.vendor_id = ${vendorId} and r.status = 'received' and r.received_at < now() - interval '3 days'`);
  await add('refunds_pending', 'returns', 'info', 'Refunds still pending on returns that are already received', sql`select count(*)::int c, (array_agg(r.id))[1:5] ids from return_orders r where r.vendor_id = ${vendorId} and r.refund_status = 'pending' and r.status in ('received','inspecting','completed')`);
  await add('sync_failures', 'sync', 'warning', 'Marketplace sync jobs that failed in the last 24 hours', sql`select count(*)::int c, (array_agg(s.id))[1:5] ids from sync_jobs s where s.vendor_id = ${vendorId} and s.status in ('failed','partially_failed') and s.updated_at > now() - interval '24 hours'`);
  await add('sync_dead_lettered', 'sync', 'critical', 'Sync jobs that gave up and need a person', sql`select count(*)::int c, (array_agg(s.id))[1:5] ids from sync_jobs s where s.vendor_id = ${vendorId} and s.status = 'dead_lettered'`);
  await add('marketplace_disconnected', 'marketplace', 'critical', 'Marketplace connections that are expired, errored or disconnected', sql`select count(*)::int c, (array_agg(a.id))[1:5] ids from marketplace_accounts a where a.vendor_id = ${vendorId} and a.status in ('error','expired','revoked_pending') or (a.vendor_id = ${vendorId} and a.connection_status in ('error','unauthorized','disconnected'))`);
  await add('listings_rejected', 'marketplace', 'warning', 'Listings rejected by a marketplace', sql`select count(*)::int c, (array_agg(l.id))[1:5] ids from marketplace_listings l where l.vendor_id = ${vendorId} and l.status in ('rejected','correction_required')`);
  const score = healthScore(issues);
  return { score, grade: (score >= 90 ? 'healthy' : score >= 70 ? 'needs_attention' : 'at_risk') as 'healthy' | 'needs_attention' | 'at_risk', issues: issues.sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity] || b.count - a.count), generatedAt: new Date().toISOString() };
}
