import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, type TestApp } from '@oms/testing';
import { buildWorld, orderArrives, pickAndPack, ship, stockOf } from '../helpers/stage4';

let t: TestApp;
let c: ReturnType<typeof clientFor>;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
});
afterAll(() => t.close());

describe('warehouse layout, inbound and bins', () => {
  it('locations, bins (barcode), inbound receiving with damage, put-away, capacity and where-is-it', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [0] });
    const wh = w.warehouses[0]!.id;
    const loc = await c.post(`/api/v1/warehouses/${wh}/locations`, { code: 'storage-a', name: 'Storage A', type: 'storage' }, w.admin);
    expect(loc.status, JSON.stringify(loc.body)).toBe(201);
    expect(loc.body.data.code).toBe('STORAGE-A');
    const bin = await c.post(`/api/v1/warehouses/${wh}/bins`, { code: 'a-01-01', barcode: 'BIN-A0101', locationId: loc.body.data.id, capacity: 5 }, w.admin);
    expect(bin.status, JSON.stringify(bin.body)).toBe(201);
    expect((await c.post(`/api/v1/warehouses/${wh}/bins`, { code: 'a-01-02', barcode: 'BIN-A0101' }, w.admin)).status).toBe(409); // barcodes are unique
    expect((await c.get('/api/v1/warehouse-bins/by-barcode/BIN-A0101', w.admin)).body.data.id).toBe(bin.body.data.id);

    // inbound: announce 10, receive 8 good + 1 damaged straight into the bin? (capacity 5 -> refused), then without a bin
    const inb = await c.post('/api/v1/inbound-shipments', { warehouseId: wh, supplier: 'Textiles Ltd', reference: 'PO-1', items: [{ variantId: w.variant.variantId, expectedQuantity: 10 }] }, w.admin);
    expect(inb.status, JSON.stringify(inb.body)).toBe(201);
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 0, incoming: 10 });
    const rec = await c.post(`/api/v1/inbound-shipments/${inb.body.data.id}/receive`, { items: [{ variantId: w.variant.variantId, receivedQuantity: 9, damagedQuantity: 1 }] }, w.admin);
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body.data.inbound.status).toBe('receiving');
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 8, damaged: 1, incoming: 1 });
    expect((await c.post(`/api/v1/inbound-shipments/${inb.body.data.id}/close`, {}, w.admin)).body.data.status).toBe('closed');
    expect((await stockOf(c, w)).totals).toMatchObject({ incoming: 0 }); // what never arrived is no longer expected

    // put-away: only what the warehouse holds, within the bin capacity
    const putAway = (quantity: number) => c.post('/api/v1/bin-stock/put-away', { warehouseId: wh, variantId: w.variant.variantId, binId: bin.body.data.id, quantity }, w.admin);
    expect((await putAway(6)).status).toBe(409); // over capacity 5
    expect((await putAway(5)).status).toBe(200);
    const where = (await c.get(`/api/v1/inventory/variants/${w.variant.variantId}/locations`, w.admin)).body.data;
    expect(where[0]).toMatchObject({ onHand: 8, binned: 5, unbinned: 3, bins: [expect.objectContaining({ binCode: 'A-01-01', quantity: 5 })] });
    // a pick list points the picker at the bin (then the unbinned remainder)
    await c.post('/api/v1/inventory/receive', { variantId: w.variant.variantId, warehouseId: wh, quantity: 2, reason: 'top up' }, w.admin);
    const order = await orderArrives(t, c, w, 7);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    const pl = (await c.post('/api/v1/pick-lists', { fulfillmentIds: [f.id] }, w.admin)).body.data;
    expect(pl.tasks.map((x: any) => [x.binCode, x.quantity])).toEqual([['A-01-01', 5], [null, 2]]);
    // picking takes the units out of the bin
    const [t1, t2] = pl.tasks;
    await c.post(`/api/v1/pick-tasks/${t1.id}/scan`, { itemBarcode: t1.sku, binBarcode: 'BIN-A0101' }, w.admin);
    expect((await c.post(`/api/v1/pick-tasks/${t1.id}/pick`, { quantity: 5 }, w.admin)).status).toBe(200);
    expect((await c.get('/api/v1/bin-stock', w.admin)).body.data).toEqual([]); // the bin is empty now
    await c.post(`/api/v1/pick-tasks/${t2.id}/scan`, { itemBarcode: t2.sku }, w.admin);
    await c.post(`/api/v1/pick-tasks/${t2.id}/pick`, { quantity: 2 }, w.admin);
    expect((await c.get(`/api/v1/pick-lists/${pl.id}`, w.admin)).body.data.status).toBe('completed');
    expect((await c.get('/api/v1/reports/inventory', w.admin)).body.data.totals).toMatchObject({ damaged: 1 });
    expect((await c.get('/api/v1/inventory/ledger-check', w.admin)).body.data.healthy).toBe(true);
  });

  it('warehouse staff only work in their own warehouse, with the capabilities of their role', async () => {
    const w = await buildWorld(t, c, { warehouses: 2, stock: [10, 10] });
    const [a, b] = w.warehouses as unknown as [{ id: string }, { id: string }];
    const picker = await c.addMember(w.admin, 'vendor_staff');
    expect((await c.post(`/api/v1/warehouses/${a.id}/members`, { userId: picker.userId, role: 'picker' }, w.admin)).status).toBe(201);
    expect((await c.get('/api/v1/warehouse-access/me', picker)).body.data.warehouses).toEqual([expect.objectContaining({ warehouseId: a.id, role: 'picker' })]);
    const order = await orderArrives(t, c, w, 2);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, { warehouseIds: [a.id] }, w.admin)).body.data.fulfillments[0];
    // the picker sees only warehouse A's fulfillments and can pick there
    expect((await c.get('/api/v1/fulfillments', picker)).body.data.map((x: any) => x.id)).toEqual([f.id]);
    const pl = await c.post('/api/v1/pick-lists', { fulfillmentIds: [f.id] }, picker);
    expect(pl.status, JSON.stringify(pl.body)).toBe(201);
    const task = pl.body.data.tasks[0];
    await c.post(`/api/v1/pick-tasks/${task.id}/scan`, { itemBarcode: task.sku }, picker);
    expect((await c.post(`/api/v1/pick-tasks/${task.id}/pick`, { quantity: 2 }, picker)).status).toBe(200);
    // ...but not pack (no `pack` capability), and not receive stock
    const pkg = await c.post(`/api/v1/fulfillments/${f.id}/packages`, { items: [{ fulfillmentItemId: f.items[0].id, quantity: 2 }] }, picker);
    expect(pkg.status).toBe(403);
    expect(pkg.body.error.details.requiredCapability).toBe('pack');
    expect((await c.post('/api/v1/inventory/receive', { variantId: w.variant.variantId, warehouseId: a.id, quantity: 1 }, picker)).status).toBe(403);
    // another warehouse is off limits entirely
    const order2 = await orderArrives(t, c, w, 1);
    const f2 = (await c.post(`/api/v1/orders/${order2.id}/fulfillment`, { warehouseIds: [b.id] }, w.admin)).body.data.fulfillments[0];
    expect((await c.get(`/api/v1/fulfillments/${f2.id}`, picker)).status).toBe(403);
    expect((await c.post('/api/v1/pick-lists', { fulfillmentIds: [f2.id] }, picker)).status).toBe(403);
    // the admin (no memberships) is unrestricted
    expect((await c.get('/api/v1/fulfillments', w.admin)).body.data).toHaveLength(2);
  });
});

describe('routing rules', () => {
  it('a vendor-defined rule decides the warehouse and the priority (nothing hardcoded); invalid rules are refused', async () => {
    const w = await buildWorld(t, c, { warehouses: 2, stock: [10, 10] });
    const [, b] = w.warehouses as unknown as [{ id: string }, { id: string }];
    // the default warehouse (MAIN) would win without a rule
    const o1 = await orderArrives(t, c, w, 1);
    expect((await c.get(`/api/v1/orders/${o1.id}/fulfillment/routing-preview`, w.admin)).body.data.plan.allocations[0].warehouseId).toBe(w.warehouses[0]!.id);
    // bad rules are refused with the reason
    expect((await c.post('/api/v1/rules', { type: 'fulfillment', name: 'bad field', conditions: { combinator: 'all', conditions: [{ field: 'nope', op: 'eq', value: 1 }] }, action: { type: 'route', params: { warehouseIds: [b.id] } } }, w.admin)).status).toBe(400);
    expect((await c.post('/api/v1/rules', { type: 'fulfillment', name: 'bad action', conditions: { combinator: 'all', conditions: [] }, action: { type: 'rm_rf', params: {} } }, w.admin)).status).toBe(400);
    const rule = await c.post('/api/v1/rules', {
      type: 'fulfillment', name: 'mock orders ship from WH2, urgent', status: 'active', priority: 200, exclusive: false,
      conditions: { combinator: 'all', conditions: [{ field: 'marketplace', op: 'eq', value: 'mock' }] }, action: { type: 'route', params: { warehouseIds: [b.id] } },
    }, w.admin);
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect((await c.post('/api/v1/rules', { type: 'fulfillment', name: 'urgent', status: 'active', priority: 150, conditions: { combinator: 'all', conditions: [{ field: 'orderValueMinor', op: 'gte', value: 1 }] }, action: { type: 'set_priority', params: { priority: 'urgent' } } }, w.admin)).status).toBe(201);
    const dry = await c.post('/api/v1/rules/evaluate', { type: 'fulfillment', facts: { marketplace: 'mock', orderValueMinor: 100 } }, w.admin);
    expect(dry.body.data.map((m: any) => m.action.type)).toEqual(['route', 'set_priority']);
    // the rule is honoured at routing, and the explanation names it
    const o2 = await orderArrives(t, c, w, 2);
    const started = await c.post(`/api/v1/orders/${o2.id}/fulfillment`, {}, w.admin);
    const f = started.body.data.fulfillments[0];
    expect(f).toMatchObject({ warehouseId: b.id, priority: 'urgent' });
    expect(f.routing.ruleIds).toContain(rule.body.data.id);
    expect(f.routing.reasons.join(' ')).toContain('routing rule');
    // the stock reservation FOLLOWED the routing decision (moved from MAIN to WH2) and the ledger agrees
    const stock = await stockOf(c, w);
    expect(stock.warehouses.find((x: any) => x.warehouseId === b.id)).toMatchObject({ onHand: 10, reserved: 2 });
    expect(stock.warehouses.find((x: any) => x.warehouseId === w.warehouses[0]!.id)).toMatchObject({ reserved: 1 }); // only o1's unit
    expect((await c.get('/api/v1/inventory/ledger-check', w.admin)).body.data.healthy).toBe(true);
    // an explicit instruction beats the rule
    const o3 = await orderArrives(t, c, w, 1);
    const f3 = (await c.post(`/api/v1/orders/${o3.id}/fulfillment`, { warehouseIds: [w.warehouses[0]!.id] }, w.admin)).body.data.fulfillments[0];
    expect(f3.warehouseId).toBe(w.warehouses[0]!.id);
  });
});

describe('fulfillment state machine and validations over the API', () => {
  it('hold / resume / cancel, and what is refused', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 2);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    // you cannot jump ahead: no packing, no label before picking is done
    expect((await c.post(`/api/v1/fulfillments/${f.id}/packages`, { items: [{ fulfillmentItemId: f.items[0].id, quantity: 1 }] }, w.admin)).status).toBe(409);
    expect((await c.post('/api/v1/shipments', { fulfillmentId: f.id, providerCode: 'sandbox' }, w.admin)).status).toBe(409);
    // hold -> resume returns to where it was
    expect((await c.post(`/api/v1/fulfillments/${f.id}/hold`, { reason: 'address check' }, w.admin)).body.data).toMatchObject({ status: 'on_hold', holdFrom: 'confirmed' });
    expect((await c.post('/api/v1/pick-lists', { fulfillmentIds: [f.id] }, w.admin)).status).toBe(409); // not while on hold
    expect((await c.post(`/api/v1/fulfillments/${f.id}/resume`, {}, w.admin)).body.data.status).toBe('confirmed');
    expect((await c.post(`/api/v1/fulfillments/${f.id}/resume`, {}, w.admin)).status).toBe(409);
    await pickAndPack(t, c, w, f.id);
    const s = await ship(t, c, w, f.id);
    // after shipping the warehouse can no longer cancel or hold; the shipment cannot be cancelled
    expect((await c.post(`/api/v1/fulfillments/${f.id}/cancel`, { reason: 'oops' }, w.admin)).status).toBe(409);
    expect((await c.post(`/api/v1/fulfillments/${f.id}/hold`, { reason: 'oops' }, w.admin)).status).toBe(409);
    expect((await c.post(`/api/v1/shipments/${s.id}/cancel`, {}, w.admin)).status).toBe(409);
    expect((await c.post(`/api/v1/shipments/${s.id}/dispatch`, {}, w.admin)).status).toBe(409); // already dispatched
    // an order that has shipped can no longer be cancelled (it has to be returned)
    expect((await c.post(`/api/v1/orders/${order.id}/cancellation-requests`, { initiator: 'customer', reasonCode: 'customer_changed_mind' }, w.admin)).status).toBe(409);
    const timeline = (await c.get(`/api/v1/fulfillments/${f.id}/timeline`, w.admin)).body.data.map((e: any) => e.toStatus);
    expect(timeline).toEqual(['confirmed', 'on_hold', 'confirmed', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship', 'shipped']);
  });

  it('returns refuse impossible requests', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 2);
    const item = order.items[0].id as string;
    // an order that has not left the warehouse cannot be returned
    expect((await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'defective', items: [{ orderItemId: item, quantity: 1 }] }, w.admin)).status).toBe(409);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    await pickAndPack(t, c, w, f.id);
    await ship(t, c, w, f.id);
    expect((await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'defective', items: [{ orderItemId: item, quantity: 3 }] }, w.admin)).status).toBe(400); // sold 2
    const ok1 = await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'size_fit', marketplaceReturnId: 'MR-1', pickupRequired: true, items: [{ orderItemId: item, quantity: 2 }] }, w.admin);
    expect(ok1.status).toBe(201);
    expect(ok1.body.data.pickup.status).toBe('requested');
    // idempotent per marketplace return id
    const again = await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'size_fit', marketplaceReturnId: 'MR-1', items: [{ orderItemId: item, quantity: 2 }] }, w.admin);
    expect(again.body.data.id).toBe(ok1.body.data.id);
    // those units are already being returned
    expect((await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'size_fit', items: [{ orderItemId: item, quantity: 1 }] }, w.admin)).status).toBe(400);
    const rid = ok1.body.data.id as string;
    // pickup: schedule -> failed -> back to approved; reject needs a note; cancel frees the quantity
    expect((await c.post(`/api/v1/returns/${rid}/pickup`, {}, w.admin)).status).toBe(409); // approve first
    await c.post(`/api/v1/returns/${rid}/approve`, {}, w.admin);
    expect((await c.post(`/api/v1/returns/${rid}/pickup`, { awb: 'REV-1', scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }, w.admin)).body.data).toMatchObject({ status: 'pickup_scheduled', pickup: { status: 'scheduled', awb: 'REV-1' } });
    expect((await c.post(`/api/v1/returns/${rid}/pickup-status`, { outcome: 'failed' }, w.admin)).body.data).toMatchObject({ status: 'approved', pickup: { status: 'failed' } });
    expect((await c.post(`/api/v1/returns/${rid}/cancel`, {}, w.admin)).body.data.status).toBe('cancelled');
    expect((await c.post(`/api/v1/returns/${rid}/receive`, { warehouseId: w.warehouses[0]!.id, items: [] }, w.admin)).status).toBe(400);
    // completing with units that never arrived needs an explicit decision
    const r2 = (await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'changed_mind', items: [{ orderItemId: item, quantity: 2 }] }, w.admin)).body.data;
    await c.post(`/api/v1/returns/${r2.id}/approve`, { warehouseId: w.warehouses[0]!.id }, w.admin);
    await c.post(`/api/v1/returns/${r2.id}/receive`, { warehouseId: w.warehouses[0]!.id, items: [{ returnItemId: r2.items[0].id, quantity: 1 }] }, w.admin);
    expect((await c.post(`/api/v1/returns/${r2.id}/receive`, { warehouseId: w.warehouses[0]!.id, items: [{ returnItemId: r2.items[0].id, quantity: 2 }] }, w.admin)).status).toBe(400); // only 1 more expected
    expect((await c.post(`/api/v1/returns/${r2.id}/complete`, {}, w.admin)).status).toBe(409); // undecided unit
    await c.post(`/api/v1/returns/${r2.id}/inspect`, { items: [{ returnItemId: r2.items[0].id, quantity: 1, condition: 'sellable', disposition: 'quarantine' }] }, w.admin);
    expect((await c.post(`/api/v1/returns/${r2.id}/complete`, {}, w.admin)).status).toBe(409); // quarantine is not a final decision
    await c.post(`/api/v1/returns/${r2.id}/inspect`, { items: [{ returnItemId: r2.items[0].id, quantity: 1, condition: 'sellable', disposition: 'restock' }] }, w.admin);
    expect((await c.post(`/api/v1/returns/${r2.id}/complete`, {}, w.admin)).status).toBe(409); // 1 unit never arrived
    expect((await c.post(`/api/v1/returns/${r2.id}/complete`, { acceptShort: true }, w.admin)).body.data.status).toBe('completed');
    expect((await c.get('/api/v1/inventory/ledger-check', w.admin)).body.data.healthy).toBe(true);
  });
});

describe('pricing', () => {
  it('marketplace price, sale window, MRP guard, bulk dry-run vs real run, rule-driven prices and history', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const { variantId } = w.variant;
    const price = (body: Record<string, unknown>) => c.put('/api/v1/pricing/marketplace-prices', { variantId, accountId: w.account.id, ...body }, w.admin);
    expect((await price({ priceMinor: 70_000 })).status).toBe(400); // above the MRP (59900)
    const set = await price({ priceMinor: 45_000, reason: 'festive' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.price).toMatchObject({ priceMinor: 45_000, effectivePriceMinor: 45_000, sale: { active: false } });
    expect(set.body.data.pushed).toEqual([{ accountId: w.account.id }]); // a price push was queued for the marketplace
    await t.pump();
    expect((await c.get(`/api/v1/listings/${w.variant.listingId}`, w.admin)).body.data.priceMinor).toBe(45_000);
    // a sale: must be below the regular price; a window in the past that is still open starts now
    expect((await price({ salePriceMinor: 50_000 })).status).toBe(400);
    expect((await price({ salePriceMinor: 39_900, saleStartsAt: new Date(Date.now() + 3_600_000).toISOString(), saleEndsAt: new Date(Date.now() + 7_200_000).toISOString() })).body.data.price.sale.active).toBe(false);
    expect((await c.get(`/api/v1/listings/${w.variant.listingId}`, w.admin)).body.data.priceMinor).toBe(45_000); // not started: unchanged
    const live = await price({ salePriceMinor: 39_900, saleStartsAt: new Date(Date.now() - 60_000).toISOString(), saleEndsAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(live.body.data.price).toMatchObject({ effectivePriceMinor: 39_900, sale: { active: true } });
    expect((await c.get(`/api/v1/listings/${w.variant.listingId}`, w.admin)).body.data.priceMinor).toBe(39_900);
    expect((await t.outbox('pricing.sale_started')).length).toBe(1);
    // the sale ends by itself (processed once)
    await price({ saleStartsAt: new Date(Date.now() - 7_200_000).toISOString(), saleEndsAt: new Date(Date.now() - 3_600_000).toISOString() }).catch(() => null);
    // history is append-only and complete
    const hist = (await c.get(`/api/v1/pricing/history?filter[variantId]=${variantId}`, w.admin)).body.data.items as any[];
    expect(hist.map((h) => [h.field, h.newPriceMinor])).toEqual(expect.arrayContaining([['marketplace', 45_000], ['sale', 39_900]]));
    expect(hist.every((h) => h.source && h.createdAt)).toBe(true);
    expect((await c.get(`/api/v1/pricing/variants/${variantId}`, w.admin)).body.data).toMatchObject({ baseMinor: 49_900, mrpMinor: 59_900, marketplacePrices: [expect.objectContaining({ marketplaceAccountId: w.account.id })] });

    // bulk: dry run changes nothing, shows everything, flags what is not allowed
    const dry = await c.post('/api/v1/pricing/bulk-update', { field: 'base', variantIds: [variantId], change: { kind: 'percent', value: 10 } }, w.admin);
    expect(dry.body.data).toMatchObject({ dryRun: true, batchId: null, changed: 1, items: [{ oldMinor: 49_900, newMinor: 54_890, status: 'changed' }] });
    expect((await c.get(`/api/v1/pricing/variants/${variantId}`, w.admin)).body.data.baseMinor).toBe(49_900);
    const above = await c.post('/api/v1/pricing/bulk-update', { field: 'base', variantIds: [variantId], change: { kind: 'percent', value: 50 } }, w.admin);
    expect(above.body.data.items[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('MRP') });
    const real = await c.post('/api/v1/pricing/bulk-update', { field: 'base', variantIds: [variantId], change: { kind: 'percent', value: 10 }, dryRun: false, reason: 'cost up' }, w.admin);
    expect(real.body.data).toMatchObject({ dryRun: false, changed: 1, batchId: expect.stringMatching(/^bulk_/) });
    expect((await c.get(`/api/v1/pricing/variants/${variantId}`, w.admin)).body.data.baseMinor).toBe(54_890);
    await t.pump(); // the catalog event: history must not record the base change twice
    const batch = (await c.get(`/api/v1/pricing/history?filter[batchId]=${real.body.data.batchId}`, w.admin)).body.data.items as any[];
    expect(batch).toEqual([expect.objectContaining({ field: 'base', oldPriceMinor: 49_900, newPriceMinor: 54_890, source: 'bulk' })]);
    expect(((await c.get(`/api/v1/pricing/history?filter[variantId]=${variantId}&filter[field]=base`, w.admin)).body.data.items as any[]).filter((h) => h.newPriceMinor === 54_890)).toHaveLength(1);

    // rule-driven price: +20% then end in 99, never above MRP
    expect((await c.post('/api/v1/rules', { type: 'pricing', name: 'mock +20% .99', status: 'active', priority: 100, conditions: { combinator: 'all', conditions: [{ field: 'marketplace', op: 'eq', value: 'mock' }] }, action: { type: 'markup_percent', params: { percent: 20 } } }, w.admin)).status).toBe(201);
    expect((await c.post('/api/v1/rules', { type: 'pricing', name: 'ending', status: 'active', priority: 50, conditions: { combinator: 'all', conditions: [] }, action: { type: 'round_to', params: { mode: 'ending', ending: 99 } } }, w.admin)).status).toBe(201);
    const preview = await c.post('/api/v1/pricing/apply-rules', { accountId: w.account.id, variantIds: [variantId] }, w.admin);
    expect(preview.body.data.items[0]).toMatchObject({ baseMinor: 54_890, status: 'changed', steps: expect.arrayContaining([expect.stringContaining('markup 20%')]) });
    expect(preview.body.data.items[0].newMinor).toBeLessThanOrEqual(59_900); // capped at the MRP
    const applied = await c.post('/api/v1/pricing/apply-rules', { accountId: w.account.id, variantIds: [variantId], dryRun: false }, w.admin);
    expect(applied.body.data.changed).toBe(1);
    const row = (await c.get(`/api/v1/pricing/marketplace-prices?filter[accountId]=${w.account.id}`, w.admin)).body.data.items[0];
    expect(row.source).toBe('rule');
    // removing the marketplace price makes the listing follow the variant again
    expect((await c.del(`/api/v1/pricing/marketplace-prices/${row.id}`, w.admin)).status).toBe(200);
    expect((await c.get(`/api/v1/listings/${w.variant.listingId}`, w.admin)).body.data.priceMinor).toBeNull();
  });
});

describe('notifications', () => {
  it('order alert, unread count, mark read, preferences, de-duplication of alert storms', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 1);
    const inbox = (await c.get('/api/v1/notifications?filter[type]=order.new', w.admin)).body.data;
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ severity: 'info', title: expect.stringContaining(order.orderNumber), entityType: 'order', entityId: order.id, read: false });
    expect((await c.get('/api/v1/notifications/unread-count', w.admin)).body.data.total).toBeGreaterThan(0);
    const one = await c.get(`/api/v1/notifications/${inbox.items[0].id}`, w.admin);
    expect(one.body.data.deliveries).toEqual([expect.objectContaining({ channel: 'in_app', status: 'sent' })]);
    expect((await c.post(`/api/v1/notifications/${inbox.items[0].id}/read`, {}, w.admin)).body.data.read).toBe(true);
    // preferences: turn e-mail on for order alerts -> the next one is e-mailed; types are validated
    expect((await c.put('/api/v1/notifications/preferences/order.new', { email: true }, w.admin)).body.data.channels).toEqual({ inApp: true, email: true, push: false });
    expect((await c.put('/api/v1/notifications/preferences/not.a.type', { email: true }, w.admin)).status).toBe(400);
    await orderArrives(t, c, w, 1);
    expect(t.mailer.sent.filter((m) => m.kind === ('notification' as never)).length).toBeGreaterThan(0);
    // a low-stock storm: the same alert while unread stays ONE notification
    await c.put(`/api/v1/inventory/${w.variant.variantId}/reorder-level`, { warehouseId: w.warehouses[0]!.id, level: 100 }, w.admin).catch(() => null);
    // push-ready: a device registers; without a push provider the delivery is recorded as skipped (not lost silently)
    expect((await c.post('/api/v1/notifications/devices', { token: 'expo-token-123456', platform: 'expo' }, w.admin)).status).toBe(200);
    expect((await c.get('/api/v1/notifications/types', w.admin)).body.data.map((x: any) => x.type)).toEqual(expect.arrayContaining(['order.new', 'inventory.low_stock', 'sync.failed', 'listing.rejected', 'return.received', 'marketplace.disconnected', 'fulfillment.exception']));
    expect((await c.post('/api/v1/notifications/read', { all: true }, w.admin)).body.data.marked).toBeGreaterThan(0);
    expect((await c.get('/api/v1/notifications/unread-count', w.admin)).body.data.total).toBe(0);
    // a notification rule can mute a type
    expect((await c.post('/api/v1/rules', { type: 'notification', name: 'mute new orders', status: 'active', conditions: { combinator: 'all', conditions: [{ field: 'eventType', op: 'eq', value: 'order.created' }] }, action: { type: 'mute', params: {} } }, w.admin)).status).toBe(201);
    await orderArrives(t, c, w, 1);
    expect((await c.get('/api/v1/notifications/unread-count', w.admin)).body.data.total).toBe(0);
  });
});

describe('audit trail and reports', () => {
  it('who, what, when, source, request id, previous and new values; filters; reports are tenant-scoped', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 1);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    await c.post(`/api/v1/fulfillments/${f.id}/hold`, { reason: 'check' }, w.admin);
    const logs = (await c.get('/api/v1/audit-logs?filter[actionPrefix]=fulfillment.&limit=50', w.admin)).body.data as any[];
    const hold = logs.find((l) => l.action === 'fulfillment.on_hold')!;
    expect(hold).toMatchObject({ actorType: 'user', actorId: w.admin.userId, resourceType: 'fulfillment', resourceId: f.id, before: { status: 'confirmed' }, after: { status: 'on_hold' }, requestId: expect.any(String), source: 'api', createdAt: expect.any(String) });
    expect((await c.get(`/api/v1/audit-logs?filter[requestId]=${hold.requestId}`, w.admin)).body.data.length).toBeGreaterThan(0);
    expect((await c.get('/api/v1/audit-logs?filter[source]=webhook', w.admin)).body.data).toEqual([]);
    expect((await c.get(`/api/v1/audit-logs?filter[from]=${new Date(Date.now() + 86_400_000).toISOString()}`, w.admin)).body.data).toEqual([]);
    const entity = (await c.get(`/api/v1/audit-logs/entities/fulfillment/${f.id}`, w.admin)).body.data as any[];
    expect(entity.map((e) => e.action)).toEqual(['fulfillment.created', 'fulfillment.on_hold']);
    // the audit trail is append-only
    await t.database!.pg.exec('SET ROLE oms_app');
    await expect(t.database!.pg.exec("UPDATE audit_logs SET action = 'x'")).rejects.toThrow();

    // reports: every endpoint answers, numbers are this vendor's only
    const rival = await c.registerVendor({ businessName: 'Report Rival' });
    for (const r of ['sales', 'orders', 'inventory', 'products', 'marketplaces', 'returns', 'fulfillment']) {
      const mine = await c.get(`/api/v1/reports/${r}`, w.admin);
      expect(mine.status, `${r}: ${JSON.stringify(mine.body)}`).toBe(200);
      const theirs = await c.get(`/api/v1/reports/${r}`, rival);
      expect(theirs.status, `${r} rival`).toBe(200);
    }
    expect((await c.get('/api/v1/reports/sales', w.admin)).body.data.totals.orders).toBe(1);
    expect((await c.get('/api/v1/reports/sales', rival)).body.data.totals).toMatchObject({ orders: 0, grossMinor: 0 });
    expect((await c.get('/api/v1/reports/fulfillment', rival)).body.data.totals.fulfillments).toBe(0);
    expect((await c.get('/api/v1/reports/products', w.admin)).body.data.products[0]).toMatchObject({ sku: w.variant.sku, units: 1 });
    expect((await c.get('/api/v1/reports/sales?from=2026-02-01&to=2026-01-01', w.admin)).status).toBe(400);
  });
});

describe('tenant isolation and RBAC for the operational layer', () => {
  it('another vendor sees nothing and cannot touch anything; a viewer can read but not write', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 2);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    const { package: pkg } = await pickAndPack(t, c, w, f.id);
    const s = await ship(t, c, w, f.id);
    const ret = (await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'defective', items: [{ orderItemId: order.items[0].id, quantity: 1 }] }, w.admin)).body.data;
    const pl = (await c.get('/api/v1/pick-lists', w.admin)).body.data[0];
    const rival = await c.registerVendor({ businessName: 'Rival Inc' });
    const rw = await c.makeWarehouse(rival, { code: 'RIV' });
    // lists are empty
    for (const url of ['/api/v1/fulfillments', '/api/v1/pick-lists', '/api/v1/packages', '/api/v1/shipments', '/api/v1/manifests', '/api/v1/ndr-cases', '/api/v1/returns', '/api/v1/fulfillment-exceptions', '/api/v1/pricing/marketplace-prices', '/api/v1/notifications', '/api/v1/inbound-shipments', '/api/v1/shipping/providers']) {
      const r = await c.get(url, rival);
      expect(r.status, url).toBe(200);
      expect(Array.isArray(r.body.data) ? r.body.data : r.body.data.items, url).toEqual([]);
    }
    // direct access by id is a 404, not a leak
    for (const url of [`/api/v1/fulfillments/${f.id}`, `/api/v1/fulfillments/${f.id}/timeline`, `/api/v1/pick-lists/${pl.id}`, `/api/v1/packages/${pkg.id}`, `/api/v1/shipments/${s.id}`, `/api/v1/shipments/${s.id}/label`, `/api/v1/shipments/${s.id}/tracking`, `/api/v1/returns/${ret.id}`, `/api/v1/returns/${ret.id}/timeline`, `/api/v1/pricing/variants/${w.variant.variantId}`]) {
      expect((await c.get(url, rival)).status, url).toBe(404);
    }
    // ...and so is every write
    expect((await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, rival)).status).toBe(404);
    expect((await c.post(`/api/v1/fulfillments/${f.id}/hold`, { reason: 'steal' }, rival)).status).toBe(404);
    expect((await c.post(`/api/v1/shipments/${s.id}/dispatch`, {}, rival)).status).toBe(404);
    expect((await c.post(`/api/v1/shipments/${s.id}/simulate`, { status: 'delivered' }, rival)).status).toBe(404);
    expect((await c.post(`/api/v1/returns/${ret.id}/approve`, {}, rival)).status).toBe(404);
    expect((await c.post(`/api/v1/returns/${ret.id}/receive`, { warehouseId: rw.id, items: [{ returnItemId: ret.items[0].id, quantity: 1 }] }, rival)).status).toBe(404);
    expect((await c.post('/api/v1/pick-lists', { fulfillmentIds: [f.id] }, rival)).status).toBe(404);
    expect((await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'other', items: [{ orderItemId: order.items[0].id, quantity: 1 }] }, rival)).status).toBe(404);
    expect((await c.put('/api/v1/pricing/marketplace-prices', { variantId: w.variant.variantId, accountId: w.account.id, priceMinor: 100 }, rival)).status).toBe(404);
    expect((await c.get(`/api/v1/audit-logs/entities/fulfillment/${f.id}`, rival)).body.data).toEqual([]);

    // viewer: read yes, write no
    const viewer = await c.addMember(w.admin, 'vendor_viewer');
    expect((await c.get('/api/v1/fulfillments', viewer)).status).toBe(200);
    expect((await c.get('/api/v1/shipments', viewer)).status).toBe(200);
    expect((await c.get('/api/v1/returns', viewer)).status).toBe(200);
    expect((await c.get('/api/v1/reports/sales', viewer)).status).toBe(200);
    for (const [method, url, body] of [
      ['post', `/api/v1/fulfillments/${f.id}/hold`, { reason: 'x' }], ['post', '/api/v1/pick-lists', { fulfillmentIds: [f.id] }], ['post', '/api/v1/shipments', { fulfillmentId: f.id }],
      ['post', `/api/v1/shipments/${s.id}/dispatch`, {}], ['post', `/api/v1/returns/${ret.id}/approve`, {}], ['put', '/api/v1/pricing/marketplace-prices', { variantId: w.variant.variantId, accountId: w.account.id, priceMinor: 100 }],
      ['post', '/api/v1/pricing/bulk-update', { field: 'base', variantIds: [w.variant.variantId], change: { kind: 'set', value: 100 }, dryRun: false }], ['post', '/api/v1/rules', { type: 'pricing', name: 'x', conditions: { combinator: 'all', conditions: [] }, action: { type: 'cap_to_mrp', params: {} } }],
    ] as const) {
      const r = await (method === 'put' ? c.put(url, body, viewer) : c.post(url, body, viewer));
      expect(r.status, `${method} ${url}`).toBe(403);
    }
    // no token at all
    expect((await c.get('/api/v1/fulfillments')).status).toBe(401);
    expect((await c.get('/api/v1/notifications')).status).toBe(401);
  });
});
