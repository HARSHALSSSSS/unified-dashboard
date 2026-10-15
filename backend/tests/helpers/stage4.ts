import { expect } from 'vitest';
import { mockControl, type Actor, type TestApp, type clientFor } from '@oms/testing';

type C = ReturnType<typeof clientFor>;

/**
 * Shared scenario builder for the Stage 4 tests: a vendor with a connected (sandbox) marketplace, warehouses, stocked variants
 * with a live listing, and a way to make a marketplace order arrive through the REAL import path.
 */
export interface World {
  admin: Actor;
  account: { id: string; sellerId: string };
  warehouses: Array<{ id: string; code: string }>;
  variant: { variantId: string; sku: string; listingId: string };
}

export async function buildWorld(t: TestApp, c: C, o: { warehouses?: number; stock?: number[]; sku?: string; barcode?: string } = {}): Promise<World> {
  mockControl.reset();
  mockControl.configure({ seedOrders: false });
  const admin = await c.registerVendor({ businessName: `Stage4 ${Math.random().toString(36).slice(2, 7)}` });
  const warehouses: World['warehouses'] = [];
  const count = o.warehouses ?? 1;
  for (let i = 0; i < count; i++) warehouses.push(await c.makeWarehouse(admin, { code: i === 0 ? 'MAIN' : `WH${i + 1}`, priority: 100 + i * 100 }));
  const account = await c.connectAccount(admin, 'mock');
  const v = await c.makeVariant(admin, { sku: o.sku, barcode: o.barcode, title: 'Stage 4 tee' });
  const stock = o.stock ?? warehouses.map(() => 20);
  for (let i = 0; i < warehouses.length; i++) if (stock[i]) await c.stock(admin, v.variantId, warehouses[i]!.id, stock[i]!);
  expect((await c.post('/api/v1/shipping/providers', { providerCode: 'sandbox' }, admin)).status).toBe(201);
  const l = (await c.post('/api/v1/listings', { marketplaceAccountId: account.id, variantId: v.variantId, marketplaceCategoryId: 'mock-apparel' }, admin)).body.data;
  expect((await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin)).body.data.validation.ready).toBe(true);
  await c.post(`/api/v1/listings/${l.id}/approve`, {}, admin);
  await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
  await t.pump();
  expect((await c.get(`/api/v1/listings/${l.id}`, admin)).body.data.status).toBe('active');
  return { admin, account: { id: account.id, sellerId: account.sellerId }, warehouses, variant: { variantId: v.variantId, sku: v.sku, listingId: l.id } };
}

/** a customer orders on the marketplace; we import it (poll) and reserve stock; returns our order */
export async function orderArrives(t: TestApp, c: C, w: World, qty: number, sku = w.variant.sku) {
  const placed = mockControl.placeOrder(w.account.sellerId, [{ sku, quantity: qty }]);
  await c.post(`/api/v1/marketplace-accounts/${w.account.id}/sync-orders`, {}, w.admin);
  await t.pump();
  const list = (await c.get(`/api/v1/orders?filter[accountId]=${w.account.id}&limit=100`, w.admin)).body.data as any[];
  const order = list.find((o) => o.externalOrderId === placed.externalOrderId);
  expect(order, 'the order was imported').toBeTruthy();
  return order as any;
}

export const stockOf = async (c: C, w: World, variantId = w.variant.variantId) => (await c.get(`/api/v1/inventory/variants/${variantId}`, w.admin)).body.data;

/** walk a fulfillment through pick + pack with barcode scans (everything in one go) */
export async function pickAndPack(t: TestApp, c: C, w: World, fulfillmentId: string, o: { weightGrams?: number } = {}) {
  const f0 = (await c.get(`/api/v1/fulfillments/${fulfillmentId}`, w.admin)).body.data;
  const pl = await c.post('/api/v1/pick-lists', { fulfillmentIds: [fulfillmentId] }, w.admin);
  expect(pl.status, JSON.stringify(pl.body)).toBe(201);
  for (const task of pl.body.data.tasks as any[]) {
    const scan = await c.post(`/api/v1/pick-tasks/${task.id}/scan`, { itemBarcode: task.sku }, w.admin);
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    const pick = await c.post(`/api/v1/pick-tasks/${task.id}/pick`, { quantity: task.quantity }, w.admin);
    expect(pick.status, JSON.stringify(pick.body)).toBe(200);
  }
  await t.pump();
  const picked = (await c.get(`/api/v1/fulfillments/${fulfillmentId}`, w.admin)).body.data;
  expect(picked.status).toBe('picked');
  const pkg = await c.post(`/api/v1/fulfillments/${fulfillmentId}/packages`, { boxType: 'small', items: f0.items.map((i: any) => ({ fulfillmentItemId: i.id, quantity: i.quantity })) }, w.admin);
  expect(pkg.status, JSON.stringify(pkg.body)).toBe(201);
  for (const line of pkg.body.data.items as any[]) expect((await c.post(`/api/v1/packages/${pkg.body.data.id}/scan`, { itemBarcode: line.sku }, w.admin)).status).toBe(200);
  const closed = await c.post(`/api/v1/packages/${pkg.body.data.id}/close`, { weightGrams: o.weightGrams ?? 600, lengthMm: 300, widthMm: 200, heightMm: 50 }, w.admin);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  await t.pump();
  const packed = (await c.get(`/api/v1/fulfillments/${fulfillmentId}`, w.admin)).body.data;
  expect(packed.status).toBe('packed');
  return { package: closed.body.data, fulfillment: packed };
}

/** label + dispatch with the sandbox courier */
export async function ship(t: TestApp, c: C, w: World, fulfillmentId: string) {
  const s = await c.post('/api/v1/shipments', { fulfillmentId, providerCode: 'sandbox' }, w.admin);
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const d = await c.post(`/api/v1/shipments/${s.body.data.id}/dispatch`, {}, w.admin);
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  await t.pump();
  return d.body.data as { id: string; awb: string; status: string };
}

export const simulate = async (t: TestApp, c: C, w: World, shipmentId: string, status: string, extra: Record<string, unknown> = {}) => {
  const r = await c.post(`/api/v1/shipments/${shipmentId}/simulate`, { status, ...extra }, w.admin);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await t.pump();
  return r.body.data;
};
