import { sql, withSystem, withVendor, type Tx } from '@oms/database';
import type { Container } from '@oms/module-kit';

/**
 * The aggregation layer. Dashboards read `analytics_daily_*` (one small row per vendor / day / marketplace or variant); these functions
 * (re)compute the rows for a window straight from the operational tables, idempotently, in ONE statement per read model. A job keeps
 * today and yesterday fresh; a backfill endpoint rebuilds history. Days are UTC dates.
 */
export interface Window { from: string; to: string } // inclusive UTC dates YYYY-MM-DD
export const day = (d: Date): string => d.toISOString().slice(0, 10);
const nextDay = (d: string): string => day(new Date(Date.parse(d) + 86_400_000));

async function rollupWindow(tx: Tx, w: Window, vendorId: string | null): Promise<void> {
  const to = nextDay(w.to);
  const v = vendorId ? sql`and o.vendor_id = ${vendorId}` : sql``;
  // sales: one row per (vendor, day, marketplace)
  await tx.execute(sql`
    insert into analytics_daily_sales (vendor_id, day, marketplace, orders, cancelled_orders, units, gross_minor, tax_minor, discount_minor, shipping_minor, delivered_orders)
    select o.vendor_id, (o.placed_at at time zone 'UTC')::date, o.marketplace,
           count(*) filter (where o.status <> 'cancelled')::int, count(*) filter (where o.status = 'cancelled')::int,
           coalesce(sum(u.units) filter (where o.status <> 'cancelled'), 0)::int,
           coalesce(sum(o.total_minor) filter (where o.status <> 'cancelled'), 0), coalesce(sum(o.tax_minor) filter (where o.status <> 'cancelled'), 0),
           coalesce(sum(o.discount_minor) filter (where o.status <> 'cancelled'), 0), coalesce(sum(o.shipping_minor) filter (where o.status <> 'cancelled'), 0),
           count(*) filter (where o.status = 'delivered')::int
    from orders o
    left join lateral (select sum(i.quantity) units from order_items i where i.order_id = o.id and i.vendor_id = o.vendor_id and i.status <> 'cancelled') u on true
    where o.placed_at >= ${w.from}::date and o.placed_at < ${to}::date ${v}
    group by 1, 2, 3
    on conflict (vendor_id, day, marketplace) do update set orders = excluded.orders, cancelled_orders = excluded.cancelled_orders, units = excluded.units, gross_minor = excluded.gross_minor,
      tax_minor = excluded.tax_minor, discount_minor = excluded.discount_minor, shipping_minor = excluded.shipping_minor, delivered_orders = excluded.delivered_orders, updated_at = now()`);
  // returns (attributed to the day the return was raised, to the marketplace of its order)
  await tx.execute(sql`
    insert into analytics_daily_sales (vendor_id, day, marketplace, returned_units, refund_minor)
    select r.vendor_id, (r.created_at at time zone 'UTC')::date, o.marketplace, coalesce(sum(ri.q), 0)::int, coalesce(sum(case when r.refund_status = 'processed' then r.refund_amount_minor else 0 end), 0)
    from return_orders r join orders o on o.id = r.order_id and o.vendor_id = r.vendor_id
    left join lateral (select sum(i.quantity) q from return_items i where i.return_order_id = r.id and i.vendor_id = r.vendor_id) ri on true
    where r.created_at >= ${w.from}::date and r.created_at < ${to}::date and r.status not in ('rejected', 'cancelled') and r.source <> 'rto' ${vendorId ? sql`and r.vendor_id = ${vendorId}` : sql``}
    group by 1, 2, 3
    on conflict (vendor_id, day, marketplace) do update set returned_units = excluded.returned_units, refund_minor = excluded.refund_minor, updated_at = now()`);
  // fulfillment speed (attributed to the day the parcel shipped)
  await tx.execute(sql`
    insert into analytics_daily_sales (vendor_id, day, marketplace, shipped_fulfillments, ship_seconds_total)
    select f.vendor_id, (f.shipped_at at time zone 'UTC')::date, o.marketplace, count(*)::int, coalesce(sum(extract(epoch from (f.shipped_at - f.created_at))), 0)::bigint
    from fulfillments f join orders o on o.id = f.order_id and o.vendor_id = f.vendor_id
    where f.shipped_at >= ${w.from}::date and f.shipped_at < ${to}::date ${vendorId ? sql`and f.vendor_id = ${vendorId}` : sql``}
    group by 1, 2, 3
    on conflict (vendor_id, day, marketplace) do update set shipped_fulfillments = excluded.shipped_fulfillments, ship_seconds_total = excluded.ship_seconds_total, updated_at = now()`);
  // products: one row per (vendor, day, variant)
  await tx.execute(sql`
    insert into analytics_daily_products (vendor_id, day, variant_id, sku, units, revenue_minor)
    select i.vendor_id, (o.placed_at at time zone 'UTC')::date, i.variant_id, max(i.sku), sum(i.quantity)::int, coalesce(sum(i.unit_price_minor * i.quantity - i.discount_minor), 0)
    from order_items i join orders o on o.id = i.order_id and o.vendor_id = i.vendor_id
    where i.variant_id is not null and o.status <> 'cancelled' and i.status <> 'cancelled' and o.placed_at >= ${w.from}::date and o.placed_at < ${to}::date ${v}
    group by 1, 2, 3
    on conflict (vendor_id, day, variant_id) do update set units = excluded.units, revenue_minor = excluded.revenue_minor, sku = excluded.sku, updated_at = now()`);
  await tx.execute(sql`
    insert into analytics_daily_products (vendor_id, day, variant_id, sku, returned_units)
    select ri.vendor_id, (r.created_at at time zone 'UTC')::date, ri.variant_id, max(pv.sku), sum(ri.quantity)::int
    from return_items ri join return_orders r on r.id = ri.return_order_id and r.vendor_id = ri.vendor_id join product_variants pv on pv.id = ri.variant_id and pv.vendor_id = ri.vendor_id
    where ri.variant_id is not null and r.created_at >= ${w.from}::date and r.created_at < ${to}::date and r.status not in ('rejected', 'cancelled') and r.source <> 'rto' ${vendorId ? sql`and r.vendor_id = ${vendorId}` : sql``}
    group by 1, 2, 3
    on conflict (vendor_id, day, variant_id) do update set returned_units = excluded.returned_units, updated_at = now()`);
}

/** every vendor, a short recent window: what the scheduled job runs */
export async function rollupRecent(c: Container, days = 2): Promise<Window> {
  const to = day(new Date());
  const w = { from: day(new Date(Date.now() - (days - 1) * 86_400_000)), to };
  await withSystem(c.database.db, (tx) => rollupWindow(tx, w, null));
  return w;
}

/** one vendor, a long window (backfill after a late import / correction); bounded so a request cannot run for minutes */
export async function rollupVendor(c: Container, vendorId: string, w: Window): Promise<void> {
  const span = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;
  if (span < 0 || span > 400) throw new Error('window must be 0-400 days');
  // in 31-day slices: short transactions, no long locks
  for (let s = Date.parse(w.from); s <= Date.parse(w.to); s += 31 * 86_400_000) {
    const from = day(new Date(s));
    const to = day(new Date(Math.min(s + 30 * 86_400_000, Date.parse(w.to))));
    await withVendor(c.database.db, vendorId, (tx) => rollupWindow(tx, { from, to }, vendorId));
  }
}

export { rollupWindow };
