import { sql, type Tx } from '@oms/database';

/**
 * Reporting foundation: plain, tenant-filtered aggregate queries over the operational tables. Every query filters on
 * vendor_id explicitly (and row-level security enforces it again), uses only indexed time windows and returns plain numbers
 * (money in minor units). Read models / exports can be added later without changing these contracts. No AI, no guesses.
 */
export type Period = 'day' | 'week' | 'month';
export interface Window { from: Date; to: Date }
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const rows = async (tx: Tx, q: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> => (await tx.execute<Record<string, unknown>>(q)).rows;
const trunc = (p: Period) => sql.raw(`'${p}'`);
const ratio = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : 0);

// ------------------------------------------------------------------------------------------------
// sales
// ------------------------------------------------------------------------------------------------
export async function salesReport(tx: Tx, vendorId: string, w: Window, f: { period: Period; marketplace?: string }) {
  const mk = f.marketplace ? sql`and o.marketplace = ${f.marketplace}` : sql``;
  const base = sql`from orders o where o.vendor_id = ${vendorId} and o.placed_at >= ${w.from} and o.placed_at < ${w.to} and o.status <> 'cancelled' ${mk}`;
  const [t] = await rows(tx, sql`select count(*)::int orders, coalesce(sum(o.subtotal_minor),0)::bigint subtotal, coalesce(sum(o.tax_minor),0)::bigint tax, coalesce(sum(o.shipping_minor),0)::bigint shipping, coalesce(sum(o.discount_minor),0)::bigint discount, coalesce(sum(o.total_minor),0)::bigint total ${base}`);
  const [u] = await rows(tx, sql`select coalesce(sum(i.quantity),0)::int units from order_items i join orders o on o.id = i.order_id and o.vendor_id = i.vendor_id where o.vendor_id = ${vendorId} and o.placed_at >= ${w.from} and o.placed_at < ${w.to} and o.status <> 'cancelled' and i.status <> 'cancelled' ${mk}`);
  const series = await rows(tx, sql`select date_trunc(${trunc(f.period)}, o.placed_at) bucket, count(*)::int orders, coalesce(sum(o.total_minor),0)::bigint total ${base} group by 1 order by 1`);
  const byMk = await rows(tx, sql`select o.marketplace, count(*)::int orders, coalesce(sum(o.total_minor),0)::bigint total ${base} group by 1 order by total desc`);
  const byPay = await rows(tx, sql`select o.payment_method method, count(*)::int orders, coalesce(sum(o.total_minor),0)::bigint total ${base} group by 1 order by total desc`);
  const orders = n(t?.orders);
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString() }, period: f.period,
    totals: { orders, units: n(u?.units), subtotalMinor: n(t?.subtotal), taxMinor: n(t?.tax), shippingMinor: n(t?.shipping), discountMinor: n(t?.discount), grossMinor: n(t?.total), averageOrderValueMinor: orders ? Math.round(n(t?.total) / orders) : 0 },
    series: series.map((r) => ({ bucket: new Date(String(r.bucket)).toISOString(), orders: n(r.orders), grossMinor: n(r.total) })),
    byMarketplace: byMk.map((r) => ({ marketplace: String(r.marketplace), orders: n(r.orders), grossMinor: n(r.total) })),
    byPaymentMethod: byPay.map((r) => ({ method: String(r.method), orders: n(r.orders), grossMinor: n(r.total) })),
  };
}

// ------------------------------------------------------------------------------------------------
// orders
// ------------------------------------------------------------------------------------------------
export async function ordersReport(tx: Tx, vendorId: string, w: Window, f: { period: Period; marketplace?: string }) {
  const mk = f.marketplace ? sql`and o.marketplace = ${f.marketplace}` : sql``;
  const base = sql`from orders o where o.vendor_id = ${vendorId} and o.placed_at >= ${w.from} and o.placed_at < ${w.to} ${mk}`;
  const byStatus = await rows(tx, sql`select o.status, count(*)::int c ${base} group by 1`);
  const byMk = await rows(tx, sql`select o.marketplace, count(*)::int c, count(*) filter (where o.status = 'cancelled')::int cancelled ${base} group by 1 order by c desc`);
  const series = await rows(tx, sql`select date_trunc(${trunc(f.period)}, o.placed_at) bucket, count(*)::int c, count(*) filter (where o.status = 'cancelled')::int cancelled ${base} group by 1 order by 1`);
  const [t] = await rows(tx, sql`select count(*)::int total, count(*) filter (where o.status = 'cancelled')::int cancelled, count(*) filter (where o.attention_reason is not null)::int attention,
    avg(extract(epoch from (o.dispatched_at - o.placed_at)))::float8 to_dispatch, avg(extract(epoch from (o.delivered_at - o.dispatched_at)))::float8 to_deliver ${base}`);
  const reasons = await rows(tx, sql`select c.reason_code, c.initiator, count(*)::int c from order_cancellations c join orders o on o.id = c.order_id and o.vendor_id = c.vendor_id where o.vendor_id = ${vendorId} and o.placed_at >= ${w.from} and o.placed_at < ${w.to} ${mk} and c.status in ('accepted', 'completed') group by 1, 2 order by c desc limit 20`);
  const total = n(t?.total);
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString() }, period: f.period,
    totals: { orders: total, cancelled: n(t?.cancelled), cancellationRate: ratio(n(t?.cancelled), total), needingAttention: n(t?.attention), avgHoursToDispatch: t?.to_dispatch == null ? null : Math.round((n(t.to_dispatch) / 3600) * 10) / 10, avgHoursToDeliver: t?.to_deliver == null ? null : Math.round((n(t.to_deliver) / 3600) * 10) / 10 },
    byStatus: byStatus.map((r) => ({ status: String(r.status), orders: n(r.c) })),
    byMarketplace: byMk.map((r) => ({ marketplace: String(r.marketplace), orders: n(r.c), cancelled: n(r.cancelled) })),
    cancellationReasons: reasons.map((r) => ({ reasonCode: String(r.reason_code), initiator: String(r.initiator), count: n(r.c) })),
    series: series.map((r) => ({ bucket: new Date(String(r.bucket)).toISOString(), orders: n(r.c), cancelled: n(r.cancelled) })),
  };
}

// ------------------------------------------------------------------------------------------------
// inventory (a snapshot now + the ledger activity in the window)
// ------------------------------------------------------------------------------------------------
export async function inventoryReport(tx: Tx, vendorId: string, w: Window, f: { warehouseId?: string }) {
  const wh = f.warehouseId ? sql`and i.warehouse_id = ${f.warehouseId}` : sql``;
  const [t] = await rows(tx, sql`select coalesce(sum(i.quantity_on_hand),0)::bigint on_hand, coalesce(sum(i.quantity_reserved),0)::bigint reserved, coalesce(sum(i.quantity_incoming),0)::bigint incoming, coalesce(sum(i.quantity_damaged),0)::bigint damaged, coalesce(sum(i.quantity_returned),0)::bigint returned,
      coalesce(sum(i.quantity_on_hand * coalesce(v.cost_price_minor, 0)),0)::bigint stock_value, count(*)::int skus,
      count(*) filter (where i.quantity_on_hand - i.quantity_reserved <= 0)::int out_of_stock,
      count(*) filter (where i.reorder_level is not null and i.quantity_on_hand - i.quantity_reserved <= i.reorder_level and i.quantity_on_hand - i.quantity_reserved > 0)::int low_stock
    from inventory i join product_variants v on v.id = i.variant_id and v.vendor_id = i.vendor_id where i.vendor_id = ${vendorId} ${wh}`);
  const byWh = await rows(tx, sql`select w.id, w.code, w.name, coalesce(sum(i.quantity_on_hand),0)::bigint on_hand, coalesce(sum(i.quantity_reserved),0)::bigint reserved, coalesce(sum(i.quantity_damaged),0)::bigint damaged, coalesce(sum(i.quantity_returned),0)::bigint returned,
      coalesce(sum(i.quantity_on_hand * coalesce(v.cost_price_minor, 0)),0)::bigint stock_value
    from inventory i join warehouses w on w.id = i.warehouse_id and w.vendor_id = i.vendor_id join product_variants v on v.id = i.variant_id and v.vendor_id = i.vendor_id where i.vendor_id = ${vendorId} ${wh} group by w.id, w.code, w.name order by w.code`);
  const moves = await rows(tx, sql`select m.type, count(*)::int c, coalesce(sum(m.delta_on_hand),0)::bigint on_hand, coalesce(sum(m.delta_reserved),0)::bigint reserved from inventory_movements m where m.vendor_id = ${vendorId} and m.created_at >= ${w.from} and m.created_at < ${w.to} ${f.warehouseId ? sql`and m.warehouse_id = ${f.warehouseId}` : sql``} group by 1 order by c desc`);
  const low = await rows(tx, sql`select v.id variant_id, v.sku, i.warehouse_id, (i.quantity_on_hand - i.quantity_reserved)::int available, i.reorder_level from inventory i join product_variants v on v.id = i.variant_id and v.vendor_id = i.vendor_id
    where i.vendor_id = ${vendorId} ${wh} and i.reorder_level is not null and i.quantity_on_hand - i.quantity_reserved <= i.reorder_level order by (i.quantity_on_hand - i.quantity_reserved) asc, v.sku limit 50`);
  return {
    asOf: new Date().toISOString(), window: { from: w.from.toISOString(), to: w.to.toISOString() },
    totals: { onHand: n(t?.on_hand), reserved: n(t?.reserved), available: n(t?.on_hand) - n(t?.reserved), incoming: n(t?.incoming), damaged: n(t?.damaged), returned: n(t?.returned), stockValueMinor: n(t?.stock_value), stockLines: n(t?.skus), outOfStock: n(t?.out_of_stock), lowStock: n(t?.low_stock) },
    byWarehouse: byWh.map((r) => ({ warehouseId: String(r.id), code: String(r.code), name: String(r.name), onHand: n(r.on_hand), reserved: n(r.reserved), damaged: n(r.damaged), returned: n(r.returned), stockValueMinor: n(r.stock_value) })),
    movements: moves.map((r) => ({ type: String(r.type), count: n(r.c), deltaOnHand: n(r.on_hand), deltaReserved: n(r.reserved) })),
    lowStock: low.map((r) => ({ variantId: String(r.variant_id), sku: String(r.sku), warehouseId: String(r.warehouse_id), available: n(r.available), reorderLevel: n(r.reorder_level) })),
  };
}

// ------------------------------------------------------------------------------------------------
// product performance
// ------------------------------------------------------------------------------------------------
export async function productsReport(tx: Tx, vendorId: string, w: Window, f: { marketplace?: string; sort: 'revenue' | 'units'; limit: number }) {
  const mk = f.marketplace ? sql`and o.marketplace = ${f.marketplace}` : sql``;
  const order = f.sort === 'units' ? sql`units desc, revenue desc` : sql`revenue desc, units desc`;
  const top = await rows(tx, sql`select i.variant_id, i.sku, max(i.title) title, sum(i.quantity)::int units, sum(i.unit_price_minor * i.quantity - i.discount_minor)::bigint revenue, count(distinct o.id)::int orders
    from order_items i join orders o on o.id = i.order_id and o.vendor_id = i.vendor_id
    where o.vendor_id = ${vendorId} and o.placed_at >= ${w.from} and o.placed_at < ${w.to} and o.status <> 'cancelled' and i.status <> 'cancelled' ${mk} group by i.variant_id, i.sku order by ${order} limit ${f.limit}`);
  const ret = top.length ? await rows(tx, sql`select ri.variant_id, sum(ri.quantity)::int returned from return_items ri join return_orders r on r.id = ri.return_order_id and r.vendor_id = ri.vendor_id where ri.vendor_id = ${vendorId} and r.created_at >= ${w.from} and r.created_at < ${w.to} and r.status not in ('rejected','cancelled') and r.source <> 'rto' group by 1`) : [];
  const [c] = await rows(tx, sql`select count(distinct i.sku)::int skus_sold from order_items i join orders o on o.id = i.order_id and o.vendor_id = i.vendor_id where o.vendor_id = ${vendorId} and o.placed_at >= ${w.from} and o.placed_at < ${w.to} and o.status <> 'cancelled' ${mk}`);
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString() }, skusSold: n(c?.skus_sold),
    products: top.map((r) => { const returned = n(ret.find((x) => String(x.variant_id) === String(r.variant_id))?.returned); return { variantId: r.variant_id ? String(r.variant_id) : null, sku: String(r.sku), title: String(r.title), units: n(r.units), orders: n(r.orders), revenueMinor: n(r.revenue), returnedUnits: returned, returnRate: ratio(returned, n(r.units)) }; }),
  };
}

// ------------------------------------------------------------------------------------------------
// marketplace performance
// ------------------------------------------------------------------------------------------------
export async function marketplacesReport(tx: Tx, vendorId: string, w: Window) {
  const sales = await rows(tx, sql`select o.marketplace_account_id account_id, o.marketplace, count(*)::int orders, count(*) filter (where o.status = 'cancelled')::int cancelled, count(*) filter (where o.status = 'returned')::int returned,
      coalesce(sum(o.total_minor) filter (where o.status <> 'cancelled'),0)::bigint revenue
    from orders o where o.vendor_id = ${vendorId} and o.placed_at >= ${w.from} and o.placed_at < ${w.to} group by 1, 2`);
  const accounts = await rows(tx, sql`select a.id, a.marketplace, a.status, a.display_name from marketplace_accounts a where a.vendor_id = ${vendorId} order by a.created_at`);
  const listings = await rows(tx, sql`select l.marketplace_account_id account_id, l.status, count(*)::int c from marketplace_listings l where l.vendor_id = ${vendorId} group by 1, 2`);
  const syncs = await rows(tx, sql`select s.marketplace_account_id account_id, count(*)::int total, count(*) filter (where s.status in ('failed','dead_lettered','partially_failed'))::int failed from sync_jobs s where s.vendor_id = ${vendorId} and s.created_at >= ${w.from} and s.created_at < ${w.to} group by 1`);
  const rets = await rows(tx, sql`select o.marketplace_account_id account_id, count(distinct r.id)::int returns from return_orders r join orders o on o.id = r.order_id and o.vendor_id = r.vendor_id where r.vendor_id = ${vendorId} and r.created_at >= ${w.from} and r.created_at < ${w.to} and r.status not in ('rejected','cancelled') group by 1`);
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    accounts: accounts.map((a) => {
      const id = String(a.id);
      const s = sales.find((x) => String(x.account_id) === id);
      const ls = listings.filter((x) => String(x.account_id) === id);
      const sy = syncs.find((x) => String(x.account_id) === id);
      const orders = n(s?.orders);
      return {
        accountId: id, marketplace: String(a.marketplace), displayName: a.display_name ? String(a.display_name) : null, status: String(a.status), orders, revenueMinor: n(s?.revenue), cancelled: n(s?.cancelled), cancellationRate: ratio(n(s?.cancelled), orders),
        returns: n(rets.find((x) => String(x.account_id) === id)?.returns), returnRate: ratio(n(rets.find((x) => String(x.account_id) === id)?.returns), orders),
        listings: Object.fromEntries(ls.map((x) => [String(x.status), n(x.c)])), syncJobs: n(sy?.total), syncFailures: n(sy?.failed), syncFailureRate: ratio(n(sy?.failed), n(sy?.total)),
      };
    }),
  };
}

// ------------------------------------------------------------------------------------------------
// returns
// ------------------------------------------------------------------------------------------------
export async function returnsReport(tx: Tx, vendorId: string, w: Window) {
  const base = sql`from return_orders r where r.vendor_id = ${vendorId} and r.created_at >= ${w.from} and r.created_at < ${w.to}`;
  const byStatus = await rows(tx, sql`select r.status, count(*)::int c ${base} group by 1`);
  const bySource = await rows(tx, sql`select r.source, count(*)::int c ${base} group by 1`);
  const byReason = await rows(tx, sql`select r.reason_code, count(*)::int c ${base} and r.status not in ('rejected','cancelled') group by 1 order by c desc limit 20`);
  const [units] = await rows(tx, sql`select coalesce(sum(i.quantity),0)::int requested, coalesce(sum(i.received_quantity),0)::int received, coalesce(sum(i.restocked_quantity),0)::int restocked, coalesce(sum(i.dispositioned_quantity),0)::int decided
    from return_items i join return_orders r on r.id = i.return_order_id and r.vendor_id = i.vendor_id where i.vendor_id = ${vendorId} and r.created_at >= ${w.from} and r.created_at < ${w.to} and r.status not in ('rejected','cancelled')`);
  const dispo = await rows(tx, sql`select i.disposition, coalesce(sum(i.dispositioned_quantity),0)::int c from return_items i join return_orders r on r.id = i.return_order_id and r.vendor_id = i.vendor_id where i.vendor_id = ${vendorId} and r.created_at >= ${w.from} and r.created_at < ${w.to} and i.disposition is not null group by 1`);
  const refunds = await rows(tx, sql`select r.refund_status, count(*)::int c, coalesce(sum(r.refund_amount_minor),0)::bigint amount ${base} and r.refund_status <> 'not_applicable' group by 1`);
  const [sold] = await rows(tx, sql`select coalesce(sum(i.quantity),0)::int units from order_items i join orders o on o.id = i.order_id and o.vendor_id = i.vendor_id where o.vendor_id = ${vendorId} and o.placed_at >= ${w.from} and o.placed_at < ${w.to} and o.status <> 'cancelled'`);
  const [t] = await rows(tx, sql`select count(*)::int total, avg(extract(epoch from (r.received_at - r.created_at)))::float8 to_receive, avg(extract(epoch from (r.completed_at - r.created_at)))::float8 to_complete ${base}`);
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    totals: { returns: n(t?.total), unitsRequested: n(units?.requested), unitsReceived: n(units?.received), unitsRestocked: n(units?.restocked), unitsDecided: n(units?.decided), unitReturnRate: ratio(n(units?.requested), n(sold?.units)), avgDaysToReceive: t?.to_receive == null ? null : Math.round((n(t.to_receive) / 86400) * 10) / 10, avgDaysToComplete: t?.to_complete == null ? null : Math.round((n(t.to_complete) / 86400) * 10) / 10 },
    byStatus: byStatus.map((r) => ({ status: String(r.status), count: n(r.c) })), bySource: bySource.map((r) => ({ source: String(r.source), count: n(r.c) })),
    byReason: byReason.map((r) => ({ reasonCode: String(r.reason_code), count: n(r.c) })), dispositions: dispo.map((r) => ({ disposition: String(r.disposition), units: n(r.c) })),
    refunds: refunds.map((r) => ({ status: String(r.refund_status), count: n(r.c), amountMinor: n(r.amount) })),
  };
}

// ------------------------------------------------------------------------------------------------
// fulfillment (warehouse + shipping performance)
// ------------------------------------------------------------------------------------------------
export async function fulfillmentReport(tx: Tx, vendorId: string, w: Window, f: { warehouseId?: string }) {
  const wh = f.warehouseId ? sql`and f.warehouse_id = ${f.warehouseId}` : sql``;
  const base = sql`from fulfillments f where f.vendor_id = ${vendorId} and f.created_at >= ${w.from} and f.created_at < ${w.to} ${wh}`;
  const byStatus = await rows(tx, sql`select f.status, count(*)::int c ${base} group by 1`);
  const byWh = await rows(tx, sql`select f.warehouse_id, w.code, count(*)::int total, count(*) filter (where f.status in ('shipped','in_transit','delivered','delivery_failed','rto_in_transit','rto_received'))::int shipped,
      avg(extract(epoch from (f.picked_at - f.created_at)))::float8 to_pick, avg(extract(epoch from (f.packed_at - f.picked_at)))::float8 to_pack, avg(extract(epoch from (f.shipped_at - f.created_at)))::float8 to_ship
    from fulfillments f join warehouses w on w.id = f.warehouse_id and w.vendor_id = f.vendor_id where f.vendor_id = ${vendorId} and f.created_at >= ${w.from} and f.created_at < ${w.to} ${wh} group by 1, 2 order by w.code`);
  const [t] = await rows(tx, sql`select count(*)::int total, avg(extract(epoch from (f.picked_at - f.created_at)))::float8 to_pick, avg(extract(epoch from (f.packed_at - f.picked_at)))::float8 to_pack, avg(extract(epoch from (f.shipped_at - f.created_at)))::float8 to_ship, avg(extract(epoch from (f.delivered_at - f.shipped_at)))::float8 to_deliver ${base}`);
  const ex = await rows(tx, sql`select e.kind, e.status, count(*)::int c from fulfillment_exceptions e join fulfillments f on f.id = e.fulfillment_id and f.vendor_id = e.vendor_id where e.vendor_id = ${vendorId} and e.created_at >= ${w.from} and e.created_at < ${w.to} ${wh} group by 1, 2 order by c desc`);
  const sh = await rows(tx, sql`select s.status, s.carrier, count(*)::int c from shipments s where s.vendor_id = ${vendorId} and s.created_at >= ${w.from} and s.created_at < ${w.to} ${f.warehouseId ? sql`and s.warehouse_id = ${f.warehouseId}` : sql``} group by 1, 2`);
  const [d] = await rows(tx, sql`select count(*) filter (where s.status = 'delivered')::int delivered, count(*) filter (where s.is_rto)::int rto, count(*) filter (where s.dispatched_at is not null)::int dispatched,
      count(*) filter (where s.status = 'delivered' and s.estimated_delivery_at is not null and s.delivered_at <= s.estimated_delivery_at)::int on_time, count(*) filter (where s.status = 'delivered' and s.estimated_delivery_at is not null)::int with_eta
    from shipments s where s.vendor_id = ${vendorId} and s.created_at >= ${w.from} and s.created_at < ${w.to} ${f.warehouseId ? sql`and s.warehouse_id = ${f.warehouseId}` : sql``}`);
  const [ndr] = await rows(tx, sql`select count(*)::int c, count(*) filter (where status = 'open')::int open from ndr_cases where vendor_id = ${vendorId} and created_at >= ${w.from} and created_at < ${w.to}`);
  const hrs = (v: unknown) => (v == null ? null : Math.round((n(v) / 3600) * 10) / 10);
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    totals: { fulfillments: n(t?.total), avgHoursToPick: hrs(t?.to_pick), avgHoursToPack: hrs(t?.to_pack), avgHoursToShip: hrs(t?.to_ship), avgHoursToDeliver: hrs(t?.to_deliver) },
    byStatus: byStatus.map((r) => ({ status: String(r.status), count: n(r.c) })),
    byWarehouse: byWh.map((r) => ({ warehouseId: String(r.warehouse_id), code: String(r.code), fulfillments: n(r.total), shipped: n(r.shipped), avgHoursToPick: hrs(r.to_pick), avgHoursToPack: hrs(r.to_pack), avgHoursToShip: hrs(r.to_ship) })),
    exceptions: ex.map((r) => ({ kind: String(r.kind), status: String(r.status), count: n(r.c) })),
    shipping: {
      byStatus: Object.entries(sh.reduce<Record<string, number>>((m, r) => ({ ...m, [String(r.status)]: (m[String(r.status)] ?? 0) + n(r.c) }), {})).map(([status, count]) => ({ status, count })),
      byCarrier: Object.entries(sh.reduce<Record<string, number>>((m, r) => ({ ...m, [String(r.carrier ?? 'unknown')]: (m[String(r.carrier ?? 'unknown')] ?? 0) + n(r.c) }), {})).map(([carrier, count]) => ({ carrier, count })),
      delivered: n(d?.delivered), dispatched: n(d?.dispatched), rto: n(d?.rto), rtoRate: ratio(n(d?.rto), n(d?.dispatched)), onTimeRate: ratio(n(d?.on_time), n(d?.with_eta)), ndrCases: n(ndr?.c), openNdr: n(ndr?.open),
    },
  };
}
