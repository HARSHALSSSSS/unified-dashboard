import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, type Actor, type TestApp } from '@oms/testing';

let t: TestApp;
let c: ReturnType<typeof clientFor>;
let admin: Actor;
let viewer: Actor;
let other: Actor;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
  admin = await c.registerVendor({ businessName: 'Stock Co' });
  viewer = await c.addMember(admin, 'vendor_viewer');
  other = await c.registerVendor({ businessName: 'Other Co' });
});
afterAll(() => t.close());

const stockOf = async (variantId: string, warehouseId: string) => (await c.get(`/api/v1/inventory?filter[variantId]=${variantId}&filter[warehouseId]=${warehouseId}`, admin)).body.data[0];
const ledgerHealthy = async (as = admin) => (await c.get('/api/v1/inventory/ledger-check', as)).body.data;

describe('warehouses', () => {
  it('first warehouse is the default; default moves explicitly; guarded deletes', async () => {
    const a = await c.makeWarehouse(admin, { code: 'blr-1' });
    expect(a).toMatchObject({ code: 'BLR-1', isDefault: true });
    const b = await c.makeWarehouse(admin, { code: 'del-1' });
    expect(b.isDefault).toBe(false);
    expect((await c.post('/api/v1/warehouses', { code: 'BLR-1', name: 'dup' }, admin)).status).toBe(409);

    expect((await c.patch(`/api/v1/warehouses/${a.id}`, { status: 'inactive' }, admin)).status).toBe(409); // default cannot be deactivated
    expect((await c.patch(`/api/v1/warehouses/${b.id}`, { isDefault: true }, admin)).body.data.isDefault).toBe(true);
    expect((await c.get(`/api/v1/warehouses/${a.id}`, admin)).body.data.isDefault).toBe(false);
    expect((await c.del(`/api/v1/warehouses/${b.id}`, admin)).status).toBe(409); // now the default
    expect((await c.del(`/api/v1/warehouses/${a.id}`, admin)).status).toBe(200);
    expect((await c.get(`/api/v1/warehouses/${a.id}`, admin)).status).toBe(404);
  });

  it('a warehouse holding stock cannot be deleted', async () => {
    const [w1, w2] = [await c.makeWarehouse(admin), await c.makeWarehouse(admin)];
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, w2.id, 3);
    const r = await c.del(`/api/v1/warehouses/${w2.id}`, admin);
    expect(r.status).toBe(409);
    expect(r.body.error.details.rule).toBe('has_stock');
    expect(w1.id).toBeTruthy();
  });

  it('is tenant-isolated and permission-gated', async () => {
    const w = await c.makeWarehouse(admin);
    expect((await c.get(`/api/v1/warehouses/${w.id}`, other)).status).toBe(404);
    expect((await c.get('/api/v1/warehouses', other)).body.data.map((x: any) => x.id)).not.toContain(w.id);
    expect((await c.post('/api/v1/warehouses', { code: 'NOPE', name: 'Viewer cannot' }, viewer)).status).toBe(403);
    expect((await c.get('/api/v1/warehouses', viewer)).status).toBe(200);
  });
});

describe('stock levels and the movement ledger', () => {
  it('every change writes a movement; stock equals the ledger', async () => {
    const wh = await c.makeWarehouse(admin);
    const v = await c.makeVariant(admin);
    const recv = await c.post('/api/v1/inventory/receive', { variantId: v.variantId, warehouseId: wh.id, quantity: 100, reason: 'PO-1' }, admin);
    expect(recv.status).toBe(200);
    expect(recv.body.data.stock).toMatchObject({ onHand: 100, reserved: 0, available: 100 });

    await c.post('/api/v1/inventory/adjust', { variantId: v.variantId, warehouseId: wh.id, delta: -4, reason: 'broken in handling' }, admin);
    await c.post('/api/v1/inventory/damage', { variantId: v.variantId, warehouseId: wh.id, quantity: 6, reason: 'water damage' }, admin);
    const s = await stockOf(v.variantId, wh.id);
    expect(s).toMatchObject({ onHand: 90, damaged: 6, available: 90 });

    const moves = (await c.get(`/api/v1/inventory/movements?filter[variantId]=${v.variantId}`, admin)).body.data.items;
    expect(moves.map((m: any) => m.type)).toEqual(['damage', 'adjust', 'receive']); // newest first
    expect(moves[0]).toMatchObject({ deltaOnHand: -6, deltaDamaged: 6, onHandAfter: 90 });
    expect(await ledgerHealthy()).toEqual({ healthy: true, drift: [] });
  });

  it('a stock count records the DIFFERENCE, never an overwrite', async () => {
    const wh = await c.makeWarehouse(admin);
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 50);
    const r = await c.post('/api/v1/inventory/adjust', { variantId: v.variantId, warehouseId: wh.id, setOnHand: 42, reason: 'cycle count' }, admin);
    expect(r.body.data.stock.onHand).toBe(42);
    const last = (await c.get(`/api/v1/inventory/movements?filter[variantId]=${v.variantId}&limit=1`, admin)).body.data.items[0];
    expect(last).toMatchObject({ type: 'count', deltaOnHand: -8, onHandAfter: 42 });
    // a count equal to the current quantity is a no-op error, not a silent overwrite
    expect((await c.post('/api/v1/inventory/adjust', { variantId: v.variantId, warehouseId: wh.id, setOnHand: 42, reason: 'again' }, admin)).status).toBe(400);
  });

  it('stock never goes negative and never below what is reserved', async () => {
    const wh = await c.makeWarehouse(admin);
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 5);
    const r = await c.post('/api/v1/inventory/adjust', { variantId: v.variantId, warehouseId: wh.id, delta: -6, reason: 'oops' }, admin);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await stockOf(v.variantId, wh.id)).onHand).toBe(5);
    expect(await ledgerHealthy()).toMatchObject({ healthy: true });
  });

  it('idempotency keys make retries safe: the same key moves stock once', async () => {
    const wh = await c.makeWarehouse(admin);
    const v = await c.makeVariant(admin);
    const body = { variantId: v.variantId, warehouseId: wh.id, quantity: 10, reason: 'PO-77', idempotencyKey: 'po-77-line-1' };
    const first = await c.post('/api/v1/inventory/receive', body, admin);
    const again = await c.post('/api/v1/inventory/receive', body, admin);
    expect(first.body.data.duplicate).toBe(false);
    expect(again.body.data.duplicate).toBe(true);
    expect((await stockOf(v.variantId, wh.id)).onHand).toBe(10);
  });

  it('incoming, returns (hold -> restock/damaged) and reorder level', async () => {
    const wh = await c.makeWarehouse(admin);
    const v = await c.makeVariant(admin);
    await c.post('/api/v1/inventory/incoming', { variantId: v.variantId, warehouseId: wh.id, quantity: 20 }, admin);
    expect(await stockOf(v.variantId, wh.id)).toMatchObject({ incoming: 20, onHand: 0 });
    await c.post('/api/v1/inventory/receive', { variantId: v.variantId, warehouseId: wh.id, quantity: 12, fromIncoming: true, reason: 'GRN' }, admin);
    expect(await stockOf(v.variantId, wh.id)).toMatchObject({ incoming: 8, onHand: 12 });

    await c.post('/api/v1/inventory/returns', { variantId: v.variantId, warehouseId: wh.id, quantity: 5, disposition: 'hold', reason: 'RTO' }, admin);
    expect(await stockOf(v.variantId, wh.id)).toMatchObject({ returned: 5, onHand: 12 });
    await c.post('/api/v1/inventory/returns/resolve', { variantId: v.variantId, warehouseId: wh.id, quantity: 3, to: 'restock', reason: 'QC pass' }, admin);
    await c.post('/api/v1/inventory/returns/resolve', { variantId: v.variantId, warehouseId: wh.id, quantity: 2, to: 'damaged', reason: 'QC fail' }, admin);
    expect(await stockOf(v.variantId, wh.id)).toMatchObject({ returned: 0, onHand: 15, damaged: 2 });

    await c.put('/api/v1/inventory/reorder-level', { variantId: v.variantId, warehouseId: wh.id, reorderLevel: 20 }, admin);
    expect((await c.get('/api/v1/inventory?filter[low]=true', admin)).body.data.map((s: any) => s.variantId)).toContain(v.variantId);
    expect(await ledgerHealthy()).toMatchObject({ healthy: true });
  });

  it('is tenant-isolated: another vendor cannot see or touch this stock', async () => {
    const wh = await c.makeWarehouse(admin);
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 9);
    expect((await c.get(`/api/v1/inventory/variants/${v.variantId}`, other)).status).toBe(404);
    expect((await c.post('/api/v1/inventory/receive', { variantId: v.variantId, warehouseId: wh.id, quantity: 1, reason: 'x1' }, other)).status).toBe(404);
    expect((await c.get('/api/v1/inventory', other)).body.data.map((s: any) => s.variantId)).not.toContain(v.variantId);
  });

  it('viewers can read stock but not change it', async () => {
    const wh = await c.makeWarehouse(admin);
    const v = await c.makeVariant(admin);
    expect((await c.post('/api/v1/inventory/receive', { variantId: v.variantId, warehouseId: wh.id, quantity: 1, reason: 'no' }, viewer)).status).toBe(403);
    expect((await c.get('/api/v1/inventory', viewer)).status).toBe(200);
  });
});

describe('transfers', () => {
  it('ship -> incoming at destination -> receive; a short receipt returns the rest to the source', async () => {
    const [from, to] = [await c.makeWarehouse(admin), await c.makeWarehouse(admin)];
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, from.id, 30);
    const tr = (await c.post('/api/v1/inventory/transfers', { fromWarehouseId: from.id, toWarehouseId: to.id, items: [{ variantId: v.variantId, quantity: 10 }] }, admin)).body.data;
    expect(tr).toMatchObject({ status: 'draft', number: expect.stringMatching(/^TR-\d{6}$/) });

    expect((await c.post(`/api/v1/inventory/transfers/${tr.id}/ship`, {}, admin)).body.data.status).toBe('in_transit');
    expect(await stockOf(v.variantId, from.id)).toMatchObject({ onHand: 20 });
    expect(await stockOf(v.variantId, to.id)).toMatchObject({ onHand: 0, incoming: 10 });
    expect((await c.post(`/api/v1/inventory/transfers/${tr.id}/ship`, {}, admin)).status).toBe(409); // not twice

    const rcv = await c.post(`/api/v1/inventory/transfers/${tr.id}/receive`, { items: [{ variantId: v.variantId, quantity: 8 }] }, admin);
    expect(rcv.body.data.status).toBe('received');
    expect(await stockOf(v.variantId, to.id)).toMatchObject({ onHand: 8, incoming: 0 });
    expect(await stockOf(v.variantId, from.id)).toMatchObject({ onHand: 22 }); // 2 short-received units came back
    expect(await ledgerHealthy()).toMatchObject({ healthy: true });
  });

  it('cancelling an in-transit transfer puts the stock back', async () => {
    const [from, to] = [await c.makeWarehouse(admin), await c.makeWarehouse(admin)];
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, from.id, 10);
    const tr = (await c.post('/api/v1/inventory/transfers', { fromWarehouseId: from.id, toWarehouseId: to.id, items: [{ variantId: v.variantId, quantity: 10 }] }, admin)).body.data;
    await c.post(`/api/v1/inventory/transfers/${tr.id}/ship`, {}, admin);
    expect((await c.post(`/api/v1/inventory/transfers/${tr.id}/cancel`, {}, admin)).body.data.status).toBe('cancelled');
    expect(await stockOf(v.variantId, from.id)).toMatchObject({ onHand: 10 });
    expect(await stockOf(v.variantId, to.id)).toMatchObject({ incoming: 0 });
    expect(await ledgerHealthy()).toMatchObject({ healthy: true });
  });

  it('cannot ship more than is available', async () => {
    const [from, to] = [await c.makeWarehouse(admin), await c.makeWarehouse(admin)];
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, from.id, 2);
    const tr = (await c.post('/api/v1/inventory/transfers', { fromWarehouseId: from.id, toWarehouseId: to.id, items: [{ variantId: v.variantId, quantity: 5 }] }, admin)).body.data;
    const r = await c.post(`/api/v1/inventory/transfers/${tr.id}/ship`, {}, admin);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await c.get(`/api/v1/inventory/transfers/${tr.id}`, admin)).body.data.status).toBe('draft'); // the failed ship rolled back completely
    expect(await stockOf(v.variantId, from.id)).toMatchObject({ onHand: 2 });
  });
});

describe('the ledger is tamper-proof', () => {
  it('movements cannot be edited or deleted, even by the application role', async () => {
    const wh = await c.makeWarehouse(admin);
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 1);
    const pg = t.database!.pg;
    // act as the tenant itself (RLS would otherwise just hide the rows): the append-only trigger must still refuse
    await pg.query(`select set_config('app.scope', 'vendor', false), set_config('app.vendor_id', $1, false)`, [admin.vendorId]);
    try {
      await expect(pg.exec(`update inventory_movements set delta_on_hand = 999`)).rejects.toThrow(/append-only|permission denied/);
      await expect(pg.exec(`delete from inventory_movements`)).rejects.toThrow(/append-only|permission denied/);
    } finally {
      await pg.query(`select set_config('app.scope', '', false), set_config('app.vendor_id', '', false)`);
    }
  });
});
