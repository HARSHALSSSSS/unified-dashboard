import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, mockControl, type TestApp } from '@oms/testing';
import { buildWorld, orderArrives, pickAndPack, ship, simulate, stockOf } from '../helpers/stage4';

/**
 * FINAL END-TO-END (Stage 4), through the public HTTP API and the real consumers / job handlers:
 *
 *   Marketplace Order -> Central Order -> Reserve Inventory -> Warehouse Selection -> Pick -> Pack -> Ship -> Dispatch -> Delivery
 *   Delivered -> Return -> Receive -> Inspect -> Restock / Disposition -> Inventory Update
 *
 * plus the exception paths (cancellation, short pick, NDR / RTO, split fulfilment). The operational layer stays connected to the
 * central inventory and order engines: the ledger must be healthy at the end of every scenario.
 */
let t: TestApp;
let c: ReturnType<typeof clientFor>;

beforeAll(async () => {
  t = await buildTestApp({ database: true, ...(process.env.DEBUG_S4 ? { config: { LOG_LEVEL: 'error' } } : {}) });
  c = clientFor(t);
});
afterAll(() => t.close());

const ledgerHealthy = async (w: Awaited<ReturnType<typeof buildWorld>>) => expect((await c.get('/api/v1/inventory/ledger-check', w.admin)).body.data).toEqual({ healthy: true, drift: [] });

describe('Stage 4 end-to-end', () => {
  it('order -> reserve -> route -> pick -> pack -> ship -> deliver -> return -> receive -> inspect -> restock', async () => {
    const w = await buildWorld(t, c, { warehouses: 2, stock: [10, 10] });
    const [main, second] = w.warehouses as unknown as [{ id: string }, { id: string }];

    // 1. the marketplace order arrives and reserves stock (default warehouse first)
    const order = await orderArrives(t, c, w, 3);
    expect(order).toMatchObject({ status: 'new', inventoryStatus: 'reserved' });
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 20, reserved: 3, available: 17 });

    // 2. routing is explainable and nothing is hardcoded: preview, then start
    const preview = (await c.get(`/api/v1/orders/${order.id}/fulfillment/routing-preview`, w.admin)).body.data;
    expect(preview.plan.allocations).toHaveLength(1);
    expect(preview.plan.allocations[0].warehouseId).toBe(main.id);
    expect(preview.plan.reasons.join(' ')).toContain('MAIN');
    const started = await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const [f] = started.body.data.fulfillments as any[];
    expect(f).toMatchObject({ status: 'confirmed', warehouseId: main.id, priority: 'normal', items: [expect.objectContaining({ quantity: 3, pickedQuantity: 0 })] });
    expect(f.routing.reasons.length).toBeGreaterThan(0);
    await t.pump();
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('confirmed');
    // starting twice is refused: every line is already in a fulfillment
    expect((await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).status).toBe(409);

    // 3. pick + pack (barcode verified)
    const { package: pkg } = await pickAndPack(t, c, w, f.id);
    expect(pkg).toMatchObject({ status: 'packed', weightGrams: 600, lengthMm: 300, items: [expect.objectContaining({ verified: true, quantity: 3 })] });
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('packed');

    // 4. shipping label (provider-neutral), then dispatch: stock leaves, the marketplace is told with the AWB
    const label = await c.post('/api/v1/shipments', { fulfillmentId: f.id, providerCode: 'sandbox' }, w.admin);
    expect(label.status, JSON.stringify(label.body)).toBe(201);
    expect(label.body.data).toMatchObject({ status: 'label_ready', providerCode: 'sandbox', carrier: 'Sandbox Express', hasLabel: true, awb: expect.stringMatching(/^SBX/) });
    expect((await c.get(`/api/v1/shipments/${label.body.data.id}/label`, w.admin)).body.data.content).toContain(label.body.data.awb);
    await t.pump();
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('ready_to_ship');
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('ready_to_dispatch');
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 20, reserved: 3 }); // still held until it leaves

    const dispatched = await c.post(`/api/v1/shipments/${label.body.data.id}/dispatch`, { packageBarcodes: [pkg.barcode] }, w.admin);
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    await t.pump();
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('shipped');
    const afterDispatch = (await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data;
    expect(afterDispatch).toMatchObject({ status: 'dispatched', inventoryStatus: 'committed', tracking: { number: label.body.data.awb, carrier: 'Sandbox Express' } });
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 17, reserved: 0, available: 17 });
    expect(mockControl.order(w.account.sellerId, order.externalOrderId)?.marketplaceStatus).toBe('shipped');

    // 5. delivery tracking: in transit -> delivered (a repeated or out-of-order courier message is harmless)
    await simulate(t, c, w, label.body.data.id, 'in_transit');
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('in_transit');
    const delivered = await simulate(t, c, w, label.body.data.id, 'delivered');
    expect(delivered.shipment).toMatchObject({ status: 'delivered' });
    const late = await simulate(t, c, w, label.body.data.id, 'in_transit'); // late message after delivery
    expect(late).toMatchObject({ applied: 0, recorded: 1 });
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('delivered');
    const tracking = (await c.get(`/api/v1/shipments/${label.body.data.id}/tracking`, w.admin)).body.data as any[];
    expect(tracking.map((e) => e.status)).toEqual(expect.arrayContaining(['label_ready', 'dispatched', 'in_transit', 'delivered']));

    // 6. the customer returns 3 units: request -> approve -> receive -> inspect (restock 2, damaged 1) -> complete
    const detail = (await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data;
    const ret = await c.post('/api/v1/returns', { orderId: order.id, source: 'customer', reasonCode: 'defective', reasonText: 'stitching came apart', items: [{ orderItemId: detail.items[0].id, quantity: 3 }] }, w.admin);
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    expect(ret.body.data).toMatchObject({ status: 'requested', refund: { status: 'pending', amountMinor: expect.any(Number) } });
    const rid = ret.body.data.id as string;
    expect((await c.post(`/api/v1/returns/${rid}/approve`, { warehouseId: main.id }, w.admin)).body.data.status).toBe('approved');
    const itemId = ret.body.data.items[0].id as string;
    // cannot inspect what has not been received
    expect((await c.post(`/api/v1/returns/${rid}/inspect`, { items: [{ returnItemId: itemId, quantity: 1, condition: 'sellable', disposition: 'restock' }] }, w.admin)).status).toBe(409);
    const received = await c.post(`/api/v1/returns/${rid}/receive`, { warehouseId: main.id, items: [{ returnItemId: itemId, quantity: 3 }] }, w.admin);
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body.data.status).toBe('received');
    // received units wait in the `returned` bucket: not sellable yet
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 17, returned: 3, available: 17 });
    // a damaged item cannot be restocked
    expect((await c.post(`/api/v1/returns/${rid}/inspect`, { items: [{ returnItemId: itemId, quantity: 1, condition: 'damaged', disposition: 'restock' }] }, w.admin)).status).toBe(400);
    const inspected = await c.post(`/api/v1/returns/${rid}/inspect`, { items: [{ returnItemId: itemId, quantity: 2, condition: 'sellable', disposition: 'restock' }, { returnItemId: itemId, quantity: 1, condition: 'defective', disposition: 'damaged' }] }, w.admin);
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    expect(inspected.body.data.items[0]).toMatchObject({ receivedQuantity: 3, dispositionedQuantity: 3, restockedQuantity: 2 });
    const done = await c.post(`/api/v1/returns/${rid}/complete`, {}, w.admin);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe('completed');
    // inventory updated through the ledger: 2 sellable again, 1 damaged, nothing left in `returned`
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 19, available: 19, returned: 0, damaged: 1 });
    await ledgerHealthy(w);
    // the whole order came back
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('returned');
    // refund is tracked
    const refund = await c.post(`/api/v1/returns/${rid}/refund`, { status: 'processed', reference: 'RFND-1' }, w.admin);
    expect(refund.body.data.refund).toMatchObject({ status: 'processed', reference: 'RFND-1' });
    expect((await c.get(`/api/v1/returns/${rid}/timeline`, w.admin)).body.data.map((e: any) => e.toStatus)).toEqual(['requested', 'approved', 'received', 'inspecting', 'completed']);

    // 7. the second warehouse was never touched; audit has the trail; reports see it all
    expect((await stockOf(c, w)).warehouses.find((x: any) => x.warehouseId === second.id)).toMatchObject({ onHand: 10, reserved: 0 });
    const audit = (await c.get(`/api/v1/audit-logs/entities/fulfillment/${f.id}`, w.admin)).body.data as any[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['fulfillment.created', 'fulfillment.picking', 'fulfillment.picked', 'fulfillment.packed', 'fulfillment.shipped', 'fulfillment.delivered']));
    expect(audit.every((a) => a.requestId || a.source)).toBe(true);
    const sales = (await c.get('/api/v1/reports/sales', w.admin)).body.data;
    expect(sales.totals.orders).toBe(1);
    const fr = (await c.get('/api/v1/reports/fulfillment', w.admin)).body.data;
    expect(fr.totals.fulfillments).toBe(1);
    expect(fr.shipping).toMatchObject({ delivered: 1, dispatched: 1 });
    const rr = (await c.get('/api/v1/reports/returns', w.admin)).body.data;
    expect(rr.totals).toMatchObject({ returns: 1, unitsReceived: 3, unitsRestocked: 2 });
    expect((await c.get('/api/v1/sync/summary', w.admin)).body.data.needsAttention).toBe(0);
  });

  it('cancellation after picking: work stops, picked units return to the shelf, stock is released', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 4);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    const pl = (await c.post('/api/v1/pick-lists', { fulfillmentIds: [f.id] }, w.admin)).body.data;
    const task = pl.tasks[0];
    // wrong item scanned is refused, the right one is accepted, partial pick is allowed
    const wrong = await c.post(`/api/v1/pick-tasks/${task.id}/scan`, { itemBarcode: 'NOT-THE-ITEM' }, w.admin);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.rule).toBe('wrong_item');
    expect((await c.post(`/api/v1/pick-tasks/${task.id}/pick`, { quantity: 1 }, w.admin)).body.error.details.rule).toBe('scan_required');
    expect((await c.post(`/api/v1/pick-tasks/${task.id}/scan`, { itemBarcode: task.sku.toLowerCase() }, w.admin)).status).toBe(200);
    const partial = await c.post(`/api/v1/pick-tasks/${task.id}/pick`, { quantity: 2 }, w.admin);
    expect(partial.body.data).toMatchObject({ status: 'partial', pickedQuantity: 2 });
    expect((await c.post(`/api/v1/pick-tasks/${task.id}/pick`, { quantity: 3 }, w.admin)).status).toBe(400); // more than asked
    await t.pump();
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('picking');

    // the customer cancels: request -> seller accepts
    const req = await c.post(`/api/v1/orders/${order.id}/cancellation-requests`, { initiator: 'customer', reasonCode: 'customer_changed_mind' }, w.admin);
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const accepted = await c.post(`/api/v1/orders/${order.id}/cancellation-requests/${req.body.data.id}/accept`, { note: 'ok' }, w.admin);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    await t.pump(); // the fulfillment + shipping consumers react to order.cancelled
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data).toMatchObject({ status: 'cancelled', inventoryStatus: 'released' });
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('cancelled');
    expect((await c.get(`/api/v1/pick-tasks?filter[fulfillmentId]=${f.id}`, w.admin)).body.data[0].status).toBe('cancelled');
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    await ledgerHealthy(w);
  });

  it('short pick: the missing units leave the books, an exception is raised, the order is flagged', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 3);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    const task = (await c.post('/api/v1/pick-lists', { fulfillmentIds: [f.id] }, w.admin)).body.data.tasks[0];
    await c.post(`/api/v1/pick-tasks/${task.id}/scan`, { itemBarcode: task.sku }, w.admin);
    await c.post(`/api/v1/pick-tasks/${task.id}/pick`, { quantity: 2 }, w.admin);
    const short = await c.post(`/api/v1/pick-tasks/${task.id}/short`, { reason: 'not on the shelf' }, w.admin);
    expect(short.status, JSON.stringify(short.body)).toBe(200);
    expect(short.body.data.task.status).toBe('short');
    expect(short.body.data.exception).toMatchObject({ kind: 'pick_short', status: 'open' });
    await t.pump();
    const fu = (await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data;
    expect(fu).toMatchObject({ status: 'picked', openExceptions: 1, items: [expect.objectContaining({ pickedQuantity: 2, shortQuantity: 1 })] });
    // the unit that was never there is written off, the reservation for it released
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 9, reserved: 2, available: 7 });
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data).toMatchObject({ inventoryStatus: 'partial', attentionReason: expect.stringContaining('short_pick') });
    const ex = (await c.get('/api/v1/fulfillment-exceptions?filter[status]=open', w.admin)).body.data as any[];
    expect(ex).toHaveLength(1);
    expect((await c.post(`/api/v1/fulfillment-exceptions/${ex[0].id}/resolve`, { note: 'recounted' }, w.admin)).body.data.status).toBe('resolved');
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.attentionReason).toBeNull(); // the human resolved it
    await ledgerHealthy(w);
    // alerts: the manager was notified of the exception
    const unread = (await c.get('/api/v1/notifications?filter[type]=fulfillment.exception', w.admin)).body.data.items as any[];
    expect(unread[0]).toMatchObject({ severity: 'warning', read: false });
  });

  it('split fulfilment across warehouses when no single warehouse has all the stock', async () => {
    const w = await buildWorld(t, c, { warehouses: 2, stock: [2, 3] });
    const [a, b] = w.warehouses as unknown as [{ id: string }, { id: string }];
    const order = await orderArrives(t, c, w, 5);
    expect(order.inventoryStatus).toBe('reserved');
    // without split permission the best warehouse takes what it has and the rest is reported
    const noSplit = (await c.get(`/api/v1/orders/${order.id}/fulfillment/routing-preview`, w.admin)).body.data.plan;
    expect(noSplit.allocations).toHaveLength(1);
    expect(noSplit.unallocated.length).toBeGreaterThan(0);
    const started = await c.post(`/api/v1/orders/${order.id}/fulfillment`, { allowSplit: true }, w.admin);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const fs = started.body.data.fulfillments as any[];
    expect(fs).toHaveLength(2);
    expect(fs.map((f) => f.warehouseId).sort()).toEqual([a.id, b.id].sort());
    expect(fs.map((f) => f.items[0].quantity).sort()).toEqual([2, 3]);
    // reservations follow the routing: all 5 units still held, each in the warehouse that will ship them
    const stock = await stockOf(c, w);
    expect(stock.totals).toMatchObject({ onHand: 5, reserved: 5, available: 0 });
    // the order is only as far along as its slowest part
    await pickAndPack(t, c, w, fs[0].id);
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('confirmed');
    await pickAndPack(t, c, w, fs[1].id);
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('packed');
    const s0 = await ship(t, c, w, fs[0].id);
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('packed'); // one part still in the warehouse
    await ship(t, c, w, fs[1].id);
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data).toMatchObject({ status: 'dispatched', inventoryStatus: 'committed' });
    expect(s0.status).toBe('dispatched');
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 0, reserved: 0 });
    await ledgerHealthy(w);
  });

  it('failed delivery (NDR) -> re-attempt fails again -> RTO -> returned to the warehouse -> inspected -> restocked', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [6] });
    const order = await orderArrives(t, c, w, 2);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    await pickAndPack(t, c, w, f.id);
    const s = await ship(t, c, w, f.id);
    await simulate(t, c, w, s.id, 'in_transit');
    // attempt 1 fails: an NDR case opens, the fulfillment shows the failure
    const failed = await simulate(t, c, w, s.id, 'delivery_failed', { reason: 'customer_unavailable' });
    expect(failed.shipment).toMatchObject({ status: 'delivery_failed', attempts: 1 });
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('delivery_failed');
    const [ndr] = (await c.get('/api/v1/ndr-cases?filter[status]=open', w.admin)).body.data as any[];
    expect(ndr).toMatchObject({ attemptNo: 1, reasonCode: 'customer_unavailable', status: 'open' });
    // retry delivery
    const act = await c.post(`/api/v1/ndr-cases/${ndr.id}/action`, { action: 'reattempt', note: 'call before delivery' }, w.admin);
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(act.body.data.ndr).toMatchObject({ status: 'action_requested', action: 'reattempt' });
    await simulate(t, c, w, s.id, 'out_for_delivery');
    expect((await c.get('/api/v1/ndr-cases?filter[status]=resolved', w.admin)).body.data).toHaveLength(1); // the re-attempt started: case resolved
    await simulate(t, c, w, s.id, 'delivery_failed', { reason: 'address_incomplete' });
    // the vendor decides: send it back
    const [ndr2] = (await c.get('/api/v1/ndr-cases?filter[status]=open', w.admin)).body.data as any[];
    expect(ndr2.attemptNo).toBe(2);
    const rto = await c.post(`/api/v1/ndr-cases/${ndr2.id}/action`, { action: 'rto' }, w.admin);
    expect(rto.body.data.shipment).toMatchObject({ status: 'rto_initiated', isRto: true });
    await simulate(t, c, w, s.id, 'rto_in_transit');
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('rto_in_transit');
    await simulate(t, c, w, s.id, 'rto_delivered');
    // back at the warehouse: fulfillment rto_received, order returned, an RTO return order was opened and already received
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('rto_received');
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('returned');
    const [ret] = (await c.get(`/api/v1/returns?filter[source]=rto`, w.admin)).body.data as any[];
    expect(ret, 'RTO return order').toMatchObject({ source: 'rto', status: 'received', shipmentId: s.id, items: [expect.objectContaining({ quantity: 2, receivedQuantity: 2 })] });
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 4, returned: 2 }); // 6 - 2 dispatched; 2 back in the returned bucket
    // inspect + restock
    const done = await c.post(`/api/v1/returns/${ret.id}/inspect`, { items: [{ returnItemId: ret.items[0].id, quantity: 2, condition: 'sellable', disposition: 'restock' }] }, w.admin);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await c.post(`/api/v1/returns/${ret.id}/complete`, {}, w.admin)).body.data.status).toBe('completed');
    expect((await stockOf(c, w)).totals).toMatchObject({ onHand: 6, available: 6, returned: 0 });
    await ledgerHealthy(w);
    // running the consumer again must not create a second return (one RTO return per shipment)
    expect((await c.get(`/api/v1/returns?filter[source]=rto`, w.admin)).body.data).toHaveLength(1);
  });

  it('three failed attempts send the parcel back automatically', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [3] });
    const order = await orderArrives(t, c, w, 1);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    await pickAndPack(t, c, w, f.id);
    const s = await ship(t, c, w, f.id);
    for (let i = 1; i <= 3; i++) {
      await simulate(t, c, w, s.id, 'in_transit');
      await simulate(t, c, w, s.id, 'delivery_failed', { reason: `attempt_${i}` });
    }
    expect((await c.get(`/api/v1/shipments/${s.id}`, w.admin)).body.data).toMatchObject({ status: 'rto_initiated', attempts: 3, isRto: true });
    expect((await c.get('/api/v1/ndr-cases?filter[status]=rto', w.admin)).body.data.length).toBeGreaterThan(0);
  });

  it('cancelling a shipment before dispatch frees the packages and the fulfillment goes back to packed', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [3] });
    const order = await orderArrives(t, c, w, 1);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    await pickAndPack(t, c, w, f.id);
    const s = (await c.post('/api/v1/shipments', { fulfillmentId: f.id, providerCode: 'sandbox' }, w.admin)).body.data;
    // a second live shipment for the same fulfillment is refused
    expect((await c.post('/api/v1/shipments', { fulfillmentId: f.id, providerCode: 'sandbox' }, w.admin)).status).toBe(409);
    const manifest = await c.post('/api/v1/manifests', { warehouseId: w.warehouses[0]!.id, shipmentIds: [s.id] }, w.admin);
    expect(manifest.status, JSON.stringify(manifest.body)).toBe(201);
    expect(manifest.body.data).toMatchObject({ status: 'open', shipmentCount: 1 });
    expect((await c.post(`/api/v1/manifests/${manifest.body.data.id}/dispatch`, {}, w.admin)).status).toBe(409); // close first
    const cancelled = await c.post(`/api/v1/shipments/${s.id}/cancel`, { reason: 'wrong courier' }, w.admin);
    expect(cancelled.body.data.status).toBe('cancelled');
    await t.pump();
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('packed');
    // a new label can be made
    const again = await c.post('/api/v1/shipments', { fulfillmentId: f.id, providerCode: 'manual', manual: { awb: 'OWN-123', carrier: 'Own fleet' } }, w.admin);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data).toMatchObject({ providerCode: 'manual', awb: 'OWN-123', carrier: 'Own fleet' });
    // manifest flow: create -> close -> dispatch dispatches the shipments
    const m2 = (await c.post('/api/v1/manifests', { warehouseId: w.warehouses[0]!.id, shipmentIds: [again.body.data.id] }, w.admin)).body.data;
    expect((await c.post(`/api/v1/manifests/${m2.id}/close`, {}, w.admin)).body.data.status).toBe('closed');
    expect((await c.post(`/api/v1/manifests/${m2.id}/dispatch`, {}, w.admin)).body.data).toMatchObject({ status: 'dispatched', shipments: [expect.objectContaining({ status: 'dispatched' })] });
    await t.pump();
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('dispatched');
    // manual tracking: staff enter the courier's updates (idempotent per event id)
    const ev = { events: [{ eventId: 'E1', status: 'delivered', occurredAt: new Date().toISOString(), location: 'Pune' }] };
    expect((await c.post(`/api/v1/shipments/${again.body.data.id}/tracking-events`, ev, w.admin)).body.data).toMatchObject({ applied: 1, recorded: 1 });
    expect((await c.post(`/api/v1/shipments/${again.body.data.id}/tracking-events`, ev, w.admin)).body.data).toMatchObject({ applied: 0, recorded: 0, duplicates: 1 });
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.status).toBe('delivered');
  });
});
