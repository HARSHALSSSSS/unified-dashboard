import { sql, type Tx } from '@oms/database';

/**
 * Profitability with HONEST data. Every money component says where it came from and is never invented:
 *   actual    = recorded fact (order revenue, courier cost on the shipment, fee / penalty entered for the order, processed refunds)
 *   estimated = derived from stated assumptions (fee profile percentage, the variant's CURRENT cost price, pending refunds)
 *   missing   = nothing to base a number on: the amount is null, not zero
 * A contribution figure is produced only when no component is missing; otherwise `contributionMinor` is null and the figure is shown as
 * `knownPartMinor` plus the list of what is missing.
 */
export type Basis = 'actual' | 'estimated' | 'missing';
export interface Component { amountMinor: number | null; basis: Basis; coverage: number }
export interface Profit {
  revenue: Component; productCost: Component; shipping: Component; marketplaceFees: Component; penalties: Component; refunds: Component;
  contributionMinor: number | null; knownPartMinor: number; marginPercent: number | null; missing: string[]; completeness: 'complete' | 'estimated' | 'incomplete';
}

const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
const rows = async (tx: Tx, q: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> => (await tx.execute<Record<string, unknown>>(q)).rows;
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nul = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface Line { variantId: string | null; sku: string; revenue: number; cost: number | null; qty: number }
interface Ord { id: string; number: string; marketplace: string; accountId: string; lines: Line[]; shipping: number | null; fee: number | null; penalty: number | null; refundProcessed: number; refundPending: number; feeProfile: { bps: number; fixed: number } | null }

const comp = (amount: number | null, basis: Basis, coverage: number): Component => ({ amountMinor: amount, basis, coverage: Math.round(coverage * 1000) / 1000 });

/** pure: the profit of a set of orders (or a slice of one) from what is known about them */
export function computeProfit(orders: Array<{ revenue: number; costKnown: number; costCovered: number; shipping: number | null; fee: number | null; penalty: number | null; refundProcessed: number; refundPending: number; feeEstimate: number | null }>): Profit {
  const revenue = orders.reduce((s, o) => s + o.revenue, 0);
  const coveredRevenue = orders.reduce((s, o) => s + o.costCovered, 0);
  const cost = comp(coveredRevenue > 0 ? orders.reduce((s, o) => s + o.costKnown, 0) : null, coveredRevenue === 0 ? 'missing' : 'estimated', revenue > 0 ? coveredRevenue / revenue : 0);
  const shipN = orders.filter((o) => o.shipping !== null).length;
  const shipping = comp(shipN ? orders.reduce((s, o) => s + (o.shipping ?? 0), 0) : null, shipN === 0 ? 'missing' : 'actual', orders.length ? shipN / orders.length : 0);
  const feeActual = orders.filter((o) => o.fee !== null).length;
  const feeEst = orders.filter((o) => o.fee === null && o.feeEstimate !== null).length;
  const fees = comp(feeActual + feeEst ? orders.reduce((s, o) => s + (o.fee ?? o.feeEstimate ?? 0), 0) : null, feeActual + feeEst === 0 ? 'missing' : feeEst > 0 ? 'estimated' : 'actual', orders.length ? (feeActual + feeEst) / orders.length : 0);
  const penN = orders.filter((o) => o.penalty !== null).length;
  const penalties = comp(penN ? orders.reduce((s, o) => s + (o.penalty ?? 0), 0) : null, penN === 0 ? 'missing' : 'actual', orders.length ? penN / orders.length : 0);
  const refundPending = orders.reduce((s, o) => s + o.refundPending, 0);
  const refunds = comp(orders.reduce((s, o) => s + o.refundProcessed + o.refundPending, 0), refundPending > 0 ? 'estimated' : 'actual', 1);
  const missing: string[] = [];
  if (cost.basis === 'missing' || cost.coverage < 1) missing.push('productCost');
  if (shipping.basis === 'missing' || shipping.coverage < 1) missing.push('shipping');
  if (fees.basis === 'missing' || fees.coverage < 1) missing.push('marketplaceFees');
  if (penalties.basis === 'missing' || penalties.coverage < 1) missing.push('penalties');
  const known = revenue - (cost.amountMinor ?? 0) - (shipping.amountMinor ?? 0) - (fees.amountMinor ?? 0) - (penalties.amountMinor ?? 0) - (refunds.amountMinor ?? 0);
  const complete = missing.length === 0;
  const anyEstimate = [cost, fees, refunds].some((c) => c.basis === 'estimated');
  return {
    revenue: comp(revenue, 'actual', 1), productCost: cost, shipping, marketplaceFees: fees, penalties, refunds,
    contributionMinor: complete ? known : null, knownPartMinor: known, marginPercent: complete && revenue > 0 ? Math.round((known / revenue) * 1000) / 10 : null,
    missing, completeness: !complete ? 'incomplete' : anyEstimate ? 'estimated' : 'complete',
  };
}

const MAX_ORDERS = 5000;

export async function profitability(tx: Tx, vendorId: string, r: { from: string; to: string }, groupBy: 'product' | 'marketplace' | 'order') {
  const ords = await rows(tx, sql`select o.id, o.order_number, o.marketplace, o.marketplace_account_id acct,
      (select sum(s.cost_minor) from shipments s where s.order_id = o.id and s.vendor_id = o.vendor_id and s.status <> 'cancelled' and s.cost_minor is not null) ship_cost,
      (select count(*) from shipments s where s.order_id = o.id and s.vendor_id = o.vendor_id and s.status <> 'cancelled') ship_n,
      f.marketplace_fee_minor fee, f.penalty_minor penalty, fp.fee_percent_bps bps, fp.fixed_fee_minor fixed,
      (select coalesce(sum(rr.refund_amount_minor), 0) from return_orders rr where rr.order_id = o.id and rr.vendor_id = o.vendor_id and rr.refund_status = 'processed') refund_done,
      (select coalesce(sum(rr.refund_amount_minor), 0) from return_orders rr where rr.order_id = o.id and rr.vendor_id = o.vendor_id and rr.refund_status = 'pending' and rr.status not in ('rejected','cancelled')) refund_pending
    from orders o left join order_financials f on f.order_id = o.id and f.vendor_id = o.vendor_id left join fee_profiles fp on fp.marketplace_account_id = o.marketplace_account_id and fp.vendor_id = o.vendor_id
    where o.vendor_id = ${vendorId} and o.status <> 'cancelled' and o.placed_at >= ${r.from}::date and o.placed_at < (${r.to}::date + 1) order by o.placed_at desc limit ${MAX_ORDERS + 1}`);
  const truncated = ords.length > MAX_ORDERS;
  const used = ords.slice(0, MAX_ORDERS);
  const ids = used.map((o) => String(o.id));
  const items = ids.length ? await rows(tx, sql`select i.order_id, i.variant_id, i.sku, i.quantity, (i.unit_price_minor * i.quantity - i.discount_minor) revenue, v.cost_price_minor cost from order_items i left join product_variants v on v.id = i.variant_id and v.vendor_id = i.vendor_id where i.vendor_id = ${vendorId} and i.order_id in (${inList(ids)}) and i.status <> 'cancelled'`) : [];

  const orders: Ord[] = used.map((o) => ({
    id: String(o.id), number: String(o.order_number), marketplace: String(o.marketplace), accountId: String(o.acct),
    lines: items.filter((i) => String(i.order_id) === String(o.id)).map((i) => ({ variantId: i.variant_id ? String(i.variant_id) : null, sku: String(i.sku), revenue: n(i.revenue), cost: nul(i.cost) === null ? null : n(i.cost) * n(i.quantity), qty: n(i.quantity) })),
    shipping: n(o.ship_n) > 0 ? nul(o.ship_cost) : null, fee: nul(o.fee), penalty: nul(o.penalty), refundProcessed: n(o.refund_done), refundPending: n(o.refund_pending), feeProfile: o.bps === null ? null : { bps: n(o.bps), fixed: n(o.fixed) },
  }));

  /** one order (or a share of it) as inputs to computeProfit; `share` allocates order-level costs to a product by revenue share */
  const toInput = (o: Ord, lines: Line[], share: number) => {
    const revenue = lines.reduce((s, l) => s + l.revenue, 0);
    const orderRevenue = o.lines.reduce((s, l) => s + l.revenue, 0);
    const covered = lines.filter((l) => l.cost !== null);
    return {
      revenue, costKnown: covered.reduce((s, l) => s + (l.cost ?? 0), 0), costCovered: covered.reduce((s, l) => s + l.revenue, 0),
      shipping: o.shipping === null ? null : Math.round(o.shipping * share), fee: o.fee === null ? null : Math.round(o.fee * share), penalty: o.penalty === null ? null : Math.round(o.penalty * share),
      refundProcessed: Math.round(o.refundProcessed * share), refundPending: Math.round(o.refundPending * share),
      feeEstimate: o.fee === null && o.feeProfile ? Math.round((orderRevenue * o.feeProfile.bps) / 10_000 * share + o.feeProfile.fixed * share) : null,
    };
  };

  const groups = new Map<string, { key: string; label: string; inputs: Array<ReturnType<typeof toInput>>; orders: Set<string> }>();
  const put = (key: string, label: string, input: ReturnType<typeof toInput>, orderId: string) => {
    const g = groups.get(key) ?? { key, label, inputs: [], orders: new Set<string>() };
    g.inputs.push(input); g.orders.add(orderId); groups.set(key, g);
  };
  for (const o of orders) {
    const orderRevenue = o.lines.reduce((s, l) => s + l.revenue, 0);
    if (groupBy === 'order') put(o.id, o.number, toInput(o, o.lines, 1), o.id);
    else if (groupBy === 'marketplace') put(o.marketplace, o.marketplace, toInput(o, o.lines, 1), o.id);
    else for (const l of o.lines) put(l.variantId ?? `sku:${l.sku}`, l.sku, toInput(o, [l], orderRevenue > 0 ? l.revenue / orderRevenue : 0), o.id);
  }
  const all = computeProfit(orders.map((o) => toInput(o, o.lines, 1)));
  return {
    range: r, groupBy, ordersAnalysed: orders.length, truncated, total: all, allocation: groupBy === 'product' ? 'order-level costs (shipping, fees, penalties, refunds) are allocated to products by revenue share' : null,
    groups: [...groups.values()].map((g) => ({ key: g.key, label: g.label, orders: g.orders.size, ...computeProfit(g.inputs) })).sort((a, b) => b.revenue.amountMinor! - a.revenue.amountMinor!).slice(0, 200),
  };
}
