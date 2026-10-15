import { sql, type Tx } from '@oms/database';

/** Reads of the aggregation layer (`analytics_daily_*`): small, indexed, vendor-scoped. Money in minor units. */
const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
const rows = async (tx: Tx, q: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> => (await tx.execute<Record<string, unknown>>(q)).rows;
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const ratio = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : 0);
const pct = (cur: number, prev: number): number | null => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
export interface Range { from: string; to: string } // inclusive UTC dates
const DAY = 86_400_000;
export const previousRange = (r: Range): Range => {
  const len = (Date.parse(r.to) - Date.parse(r.from)) / DAY + 1;
  return { from: new Date(Date.parse(r.from) - len * DAY).toISOString().slice(0, 10), to: new Date(Date.parse(r.from) - DAY).toISOString().slice(0, 10) };
};

async function salesTotals(tx: Tx, vendorId: string, r: Range) {
  const [t] = await rows(tx, sql`select coalesce(sum(orders),0)::int orders, coalesce(sum(cancelled_orders),0)::int cancelled, coalesce(sum(units),0)::int units, coalesce(sum(gross_minor),0)::bigint gross,
      coalesce(sum(tax_minor),0)::bigint tax, coalesce(sum(discount_minor),0)::bigint discount, coalesce(sum(returned_units),0)::int returned, coalesce(sum(refund_minor),0)::bigint refund,
      coalesce(sum(delivered_orders),0)::int delivered, coalesce(sum(shipped_fulfillments),0)::int shipped, coalesce(sum(ship_seconds_total),0)::bigint ship_secs
    from analytics_daily_sales where vendor_id = ${vendorId} and day between ${r.from}::date and ${r.to}::date`);
  return {
    orders: n(t?.orders), cancelledOrders: n(t?.cancelled), units: n(t?.units), grossMinor: n(t?.gross), taxMinor: n(t?.tax), discountMinor: n(t?.discount), returnedUnits: n(t?.returned), refundMinor: n(t?.refund),
    deliveredOrders: n(t?.delivered), shippedFulfillments: n(t?.shipped), shipSeconds: n(t?.ship_secs),
  };
}

/** the headline numbers, compared with the previous period of the same length */
export async function overview(tx: Tx, vendorId: string, r: Range) {
  const cur = await salesTotals(tx, vendorId, r);
  const prev = await salesTotals(tx, vendorId, previousRange(r));
  const series = await rows(tx, sql`select day::text d, sum(orders)::int orders, sum(gross_minor)::bigint gross, sum(units)::int units from analytics_daily_sales where vendor_id = ${vendorId} and day between ${r.from}::date and ${r.to}::date group by 1 order by 1`);
  const placed = cur.orders + cur.cancelledOrders;
  const kpi = (v: number, p: number) => ({ value: v, previous: p, changePercent: pct(v, p) });
  return {
    range: r, previousRange: previousRange(r),
    kpis: {
      orders: kpi(cur.orders, prev.orders), revenueMinor: kpi(cur.grossMinor, prev.grossMinor), units: kpi(cur.units, prev.units),
      averageOrderValueMinor: kpi(cur.orders ? Math.round(cur.grossMinor / cur.orders) : 0, prev.orders ? Math.round(prev.grossMinor / prev.orders) : 0),
    },
    rates: { cancellationRate: ratio(cur.cancelledOrders, placed), returnRate: ratio(cur.returnedUnits, cur.units), deliveredShare: ratio(cur.deliveredOrders, cur.orders) },
    fulfillment: { shipped: cur.shippedFulfillments, avgHoursToShip: cur.shippedFulfillments ? Math.round((cur.shipSeconds / cur.shippedFulfillments / 3600) * 10) / 10 : null },
    refundsMinor: cur.refundMinor, discountsMinor: cur.discountMinor,
    series: series.map((x) => ({ day: String(x.d), orders: n(x.orders), revenueMinor: n(x.gross), units: n(x.units) })),
  };
}

export async function marketplacePerformance(tx: Tx, vendorId: string, r: Range) {
  const sales = await rows(tx, sql`select marketplace, sum(orders)::int orders, sum(cancelled_orders)::int cancelled, sum(units)::int units, sum(gross_minor)::bigint gross, sum(returned_units)::int returned, sum(refund_minor)::bigint refund
    from analytics_daily_sales where vendor_id = ${vendorId} and day between ${r.from}::date and ${r.to}::date group by 1 order by gross desc`);
  const accounts = await rows(tx, sql`select marketplace, count(*)::int accounts, count(*) filter (where status <> 'active' or connection_status not in ('connected','unknown'))::int unhealthy from marketplace_accounts where vendor_id = ${vendorId} and status <> 'revoked' group by 1`);
  const listings = await rows(tx, sql`select a.marketplace, l.status, count(*)::int c from marketplace_listings l join marketplace_accounts a on a.id = l.marketplace_account_id and a.vendor_id = l.vendor_id where l.vendor_id = ${vendorId} group by 1, 2`);
  const syncs = await rows(tx, sql`select a.marketplace, count(*)::int total, count(*) filter (where s.status in ('failed','dead_lettered','partially_failed'))::int failed from sync_jobs s join marketplace_accounts a on a.id = s.marketplace_account_id and a.vendor_id = s.vendor_id where s.vendor_id = ${vendorId} and s.created_at >= now() - interval '7 days' group by 1`);
  const names = new Set([...sales.map((x) => String(x.marketplace)), ...accounts.map((x) => String(x.marketplace))]);
  return [...names].map((m) => {
    const s = sales.find((x) => x.marketplace === m);
    const a = accounts.find((x) => x.marketplace === m);
    const sy = syncs.find((x) => x.marketplace === m);
    const orders = n(s?.orders);
    return {
      marketplace: m, orders, revenueMinor: n(s?.gross), units: n(s?.units), cancellationRate: ratio(n(s?.cancelled), orders + n(s?.cancelled)), returnRate: ratio(n(s?.returned), n(s?.units)), refundMinor: n(s?.refund),
      accounts: n(a?.accounts), unhealthyAccounts: n(a?.unhealthy), listings: Object.fromEntries(listings.filter((x) => x.marketplace === m).map((x) => [String(x.status), n(x.c)])),
      syncJobs7d: n(sy?.total), syncFailureRate7d: ratio(n(sy?.failed), n(sy?.total)),
    };
  });
}

export async function productPerformance(tx: Tx, vendorId: string, r: Range, o: { sort: 'revenue' | 'units' | 'returns'; limit: number }) {
  const order = o.sort === 'units' ? sql`units desc` : o.sort === 'returns' ? sql`returned desc` : sql`revenue desc`;
  const top = await rows(tx, sql`select p.variant_id, max(p.sku) sku, max(pr.title) title, sum(p.units)::int units, sum(p.revenue_minor)::bigint revenue, sum(p.returned_units)::int returned
    from analytics_daily_products p left join product_variants v on v.id = p.variant_id and v.vendor_id = p.vendor_id left join products pr on pr.id = v.product_id and pr.vendor_id = v.vendor_id
    where p.vendor_id = ${vendorId} and p.day between ${r.from}::date and ${r.to}::date group by p.variant_id order by ${order} limit ${o.limit}`);
  const pr = previousRange(r);
  const prev = top.length ? await rows(tx, sql`select variant_id, sum(units)::int units from analytics_daily_products where vendor_id = ${vendorId} and day between ${pr.from}::date and ${pr.to}::date and variant_id in (${inList(top.map((t) => String(t.variant_id)))}) group by 1`) : [];
  return top.map((t) => {
    const units = n(t.units);
    const p = n(prev.find((x) => x.variant_id === t.variant_id)?.units);
    return { variantId: String(t.variant_id), sku: String(t.sku), title: t.title ? String(t.title) : null, units, revenueMinor: n(t.revenue), returnedUnits: n(t.returned), returnRate: ratio(n(t.returned), units), unitsChangePercent: pct(units, p) };
  });
}

/** daily series of units for one variant (stockout maths) or the whole vendor */
export async function dailyUnits(tx: Tx, vendorId: string, days: number): Promise<Map<string, number>> {
  const from = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const rs = await rows(tx, sql`select variant_id, sum(units)::int u from analytics_daily_products where vendor_id = ${vendorId} and day >= ${from}::date group by 1`);
  return new Map(rs.map((x) => [String(x.variant_id), n(x.u)]));
}

export async function dailyRevenueSeries(tx: Tx, vendorId: string, days: number): Promise<Array<{ day: string; orders: number; cancelled: number; returnedUnits: number; units: number; revenueMinor: number }>> {
  const from = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const rs = await rows(tx, sql`select day::text d, sum(orders)::int o, sum(cancelled_orders)::int c, sum(returned_units)::int r, sum(units)::int u, sum(gross_minor)::bigint g from analytics_daily_sales where vendor_id = ${vendorId} and day >= ${from}::date group by 1 order by 1`);
  return rs.map((x) => ({ day: String(x.d), orders: n(x.o), cancelled: n(x.c), returnedUnits: n(x.r), units: n(x.u), revenueMinor: n(x.g) }));
}
