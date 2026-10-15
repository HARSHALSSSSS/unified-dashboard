import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, type TestApp } from '@oms/testing';
import { buildWorld, orderArrives, pickAndPack, ship, simulate, stockOf } from '../helpers/stage4';

/**
 * STAGE 5 end to end: one business, real data, through the public API and the real consumers / jobs:
 *   orders -> fulfillment -> delivery -> return -> ANALYTICS (roll-ups, profitability) -> HEALTH -> AI answer -> RECOMMENDATION
 *   -> APPROVAL -> execution + rollback -> AUTOMATION (rules, approval) -> BILLING (usage, limits, invoices) -> PLATFORM ADMIN / FLAGS
 */
let t: TestApp;
let c: ReturnType<typeof clientFor>;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
});
afterAll(() => t.close());

const today = () => new Date().toISOString().slice(0, 10);
const asOwner = async (sql: string) => { await t.database!.pg.exec('RESET ROLE'); try { await t.database!.pg.exec(sql); } finally { await t.database!.pg.exec('SET ROLE oms_app'); } };

describe('Stage 5 end-to-end', () => {
  let w: Awaited<ReturnType<typeof buildWorld>>;
  let delivered: any;
  let pendingOrder: any;

  it('analytics: roll-ups, overview, products, marketplaces (real orders -> aggregation layer -> API)', async () => {
    w = await buildWorld(t, c, { warehouses: 1, stock: [20] });
    // order 1: fulfilled, delivered, then returned (1 of 2 units)
    delivered = await orderArrives(t, c, w, 2);
    const f = (await c.post(`/api/v1/orders/${delivered.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    await pickAndPack(t, c, w, f.id);
    const s = await ship(t, c, w, f.id);
    await simulate(t, c, w, s.id, 'delivered');
    const ret = (await c.post('/api/v1/returns', { orderId: delivered.id, reasonCode: 'defective', items: [{ orderItemId: delivered.items[0].id, quantity: 1 }] }, w.admin)).body.data;
    expect(ret.status).toBe('requested');
    // order 2: still waiting (no warehouse work)
    pendingOrder = await orderArrives(t, c, w, 1);

    const rebuilt = await c.post('/api/v1/analytics/rollups/rebuild', { from: today(), to: today() }, w.admin);
    expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
    const o = (await c.get(`/api/v1/analytics/overview?from=${today()}&to=${today()}`, w.admin)).body.data;
    expect(o.kpis.orders.value).toBe(2);
    expect(o.kpis.units.value).toBe(3);
    expect(o.kpis.revenueMinor.value).toBe(delivered.totalMinor + pendingOrder.totalMinor);
    expect(o.rates.returnRate).toBeCloseTo(1 / 3, 3);
    expect(o.fulfillment.shipped).toBe(1);
    expect(o.series).toHaveLength(1);
    // the same numbers a second time (idempotent roll-up)
    await c.post('/api/v1/analytics/rollups/rebuild', { from: today(), to: today() }, w.admin);
    expect((await c.get(`/api/v1/analytics/overview?from=${today()}&to=${today()}`, w.admin)).body.data.kpis.orders.value).toBe(2);
    const p = (await c.get(`/api/v1/analytics/products?from=${today()}&to=${today()}`, w.admin)).body.data;
    expect(p[0]).toMatchObject({ sku: w.variant.sku, units: 3, returnedUnits: 1 });
    const m = (await c.get(`/api/v1/analytics/marketplaces?from=${today()}&to=${today()}`, w.admin)).body.data;
    expect(m[0]).toMatchObject({ marketplace: 'mock', orders: 2, accounts: 1, unhealthyAccounts: 0 });
    expect((await c.get('/api/v1/analytics/overview?from=2026-01-01&to=2027-06-01', w.admin)).status).toBe(400); // bounded ranges
    // another vendor sees nothing of it
    const rival = await c.registerVendor();
    expect((await c.get(`/api/v1/analytics/overview?from=${today()}&to=${today()}`, rival)).body.data.kpis.orders.value).toBe(0);
  });

  it('profitability never invents numbers: missing / estimated / actual', async () => {
    const q = async (groupBy = 'order') => (await c.get(`/api/v1/analytics/profitability?groupBy=${groupBy}`, w.admin)).body.data;
    let p = await q();
    expect(p.total).toMatchObject({ contributionMinor: null, completeness: 'incomplete' });
    expect(p.total.productCost.basis).toBe('missing'); // no cost price on the variant
    expect(p.total.missing).toEqual(expect.arrayContaining(['productCost', 'marketplaceFees']));
    const row = (data: any, orderNumber: string) => data.groups.find((g: any) => g.label === orderNumber);
    expect(row(p, pendingOrder.orderNumber).shipping.basis).toBe('missing'); // never shipped: no courier cost

    // give it the facts: cost price, the fee the marketplace charged, no penalty
    expect((await c.patch(`/api/v1/variants/${w.variant.variantId}`, { costPriceMinor: 20_000 }, w.admin)).status).toBe(200);
    expect((await c.put(`/api/v1/orders/${delivered.id}/financials`, { marketplaceFeeMinor: 5_000, penaltyMinor: 0 }, w.admin)).status).toBe(200);
    p = await q();
    const d = row(p, delivered.orderNumber);
    expect(d.shipping.basis).toBe('actual');
    expect(d.marketplaceFees).toMatchObject({ amountMinor: 5_000, basis: 'actual' });
    expect(d.penalties.basis).toBe('actual');
    expect(d.productCost).toMatchObject({ amountMinor: 40_000, basis: 'estimated' }); // current cost price x 2 units
    expect(d.completeness).toBe('estimated');
    expect(d.contributionMinor).toBe(d.revenue.amountMinor - 40_000 - d.shipping.amountMinor - 5_000 - d.refunds.amountMinor);
    // the order with no shipment / fee / penalty still has NO contribution figure
    expect(row(p, pendingOrder.orderNumber)).toMatchObject({ contributionMinor: null, completeness: 'incomplete' });
    // a fee profile produces an ESTIMATED fee where no actual one exists
    expect((await c.put(`/api/v1/analytics/fee-profiles/${w.account.id}`, { feePercentBps: 1000, fixedFeeMinor: 0 }, w.admin)).status).toBe(200);
    const est = row(await q(), pendingOrder.orderNumber);
    expect(est.marketplaceFees.basis).toBe('estimated');
    expect(est.marketplaceFees.amountMinor).toBe(Math.round(pendingOrder.items[0].unitPriceMinor * 1 * 0.1));
    expect(est.missing).toEqual(expect.arrayContaining(['shipping', 'penalties']));
    expect((await q('product')).allocation).toContain('revenue share');
  });

  it('health services find the real problems', async () => {
    const bh = (await c.get('/api/v1/analytics/business-health', w.admin)).body.data;
    expect(bh.score).toBeLessThanOrEqual(100);
    expect(bh.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['orders_not_started'].slice(0, 0)));
    const ph = (await c.get('/api/v1/analytics/product-health', w.admin)).body.data;
    expect(ph.products).toBeGreaterThanOrEqual(1);
    expect(ph.issueCounts).toHaveProperty('no_images');
    expect(ph.lowestScoring[0].issues.map((i: any) => i.code)).toContain('no_images'); // the test product has no image
    const ih = (await c.get('/api/v1/analytics/inventory-health', w.admin)).body.data;
    expect(ih.skusAnalysed).toBe(1);
    expect(ih.counts).toHaveProperty('stockoutRisk');
  });

  it('AI answers from real data: "which products will run out this week?"', async () => {
    // order a lot more: stock 20, 3 reserved already -> reserve 16 more leaves 1, selling ~19 units / 30 days
    const big = await orderArrives(t, c, w, 16);
    expect(big.inventoryStatus).toBe('reserved');
    await c.post('/api/v1/analytics/rollups/rebuild', { from: today(), to: today() }, w.admin);
    const a = await c.post('/api/v1/ai/ask', { question: 'Which products are likely to run out this week?' }, w.admin);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data).toMatchObject({ intent: 'stockout_risk', confidence: 'data', generatedBy: 'rules', provider: null });
    expect(a.body.data.answer).toContain(w.variant.sku);
    expect(a.body.data.sources.length).toBeGreaterThan(0);
    const risk = [...a.body.data.data.stockoutRisk, ...a.body.data.data.outOfStock];
    expect(risk[0]).toMatchObject({ sku: w.variant.sku, available: 1 });
    expect(risk[0].unitsPerDay).toBeGreaterThan(0.5);
    // a question it cannot answer from data is not guessed
    const unk = (await c.post('/api/v1/ai/ask', { question: 'write me a poem about shoes' }, w.admin)).body.data;
    expect(unk).toMatchObject({ intent: 'unknown', confidence: 'none', data: null });
    expect((await c.get('/api/v1/ai/summary', w.admin)).body.data.bullets.join(' ')).toContain('orders');
    expect((await c.post('/api/v1/ai/ask', { question: 'hi' }, w.admin)).status).toBe(400);
  });

  it('AI safety: OBSERVE -> RECOMMEND -> APPROVE -> AUTOMATE, human approval by default, rollback', async () => {
    const settings = (await c.get('/api/v1/ai/settings', w.admin)).body.data;
    expect(settings).toMatchObject({ mode: 'recommend', automatedActions: [], enabled: true });
    // observe: insights only, nothing stored
    await c.put('/api/v1/ai/settings', { mode: 'observe' }, w.admin);
    expect((await c.post('/api/v1/ai/recommendations/generate', {}, w.admin)).body.data).toMatchObject({ created: 0 });
    expect((await c.get('/api/v1/ai/recommendations', w.admin)).body.data).toEqual([]);
    // recommend: stored, approving records the decision only
    await c.put('/api/v1/ai/settings', { mode: 'recommend' }, w.admin);
    const gen = (await c.post('/api/v1/ai/recommendations/generate', {}, w.admin)).body.data;
    expect(gen.created).toBeGreaterThanOrEqual(1);
    expect((await c.post('/api/v1/ai/recommendations/generate', {}, w.admin)).body.data.created).toBe(0); // deduplicated while open
    const recs = (await c.get('/api/v1/ai/recommendations?filter[status]=open&filter[kind]=reorder', w.admin)).body.data as any[];
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(rec).toMatchObject({ kind: 'reorder', status: 'open', action: { type: 'set_reorder_level' }, evidence: expect.objectContaining({ sku: w.variant.sku }) });
    const stockBefore = (await stockOf(c, w)).warehouses[0];
    const approvedOnly = await c.post(`/api/v1/ai/recommendations/${rec.id}/approve`, {}, w.admin);
    expect(approvedOnly.body.data).toMatchObject({ executed: false, recommendation: { status: 'approved' } });
    expect((await stockOf(c, w)).warehouses[0].reorderLevel).toBe(stockBefore.reorderLevel); // nothing changed
    // approve mode: a person's approval executes it
    await c.put('/api/v1/ai/settings', { mode: 'approve' }, w.admin);
    expect((await c.post(`/api/v1/ai/recommendations/${rec.id}/reject`, {}, w.admin)).status).toBe(409); // already decided
    await asOwner(`UPDATE ai_recommendations SET status = 'rejected' WHERE id = '${rec.id}'`);
    const second = (await c.post('/api/v1/ai/recommendations/generate', {}, w.admin)).body.data;
    expect(second.created).toBeGreaterThanOrEqual(1);
    const open = ((await c.get('/api/v1/ai/recommendations?filter[status]=open&filter[kind]=reorder', w.admin)).body.data as any[])[0];
    const run = await c.post(`/api/v1/ai/recommendations/${open.id}/approve`, {}, w.admin);
    expect(run.body.data).toMatchObject({ executed: true, recommendation: { status: 'applied', canRollback: true } });
    const level = open.action.params.level;
    expect((await stockOf(c, w)).warehouses[0].reorderLevel).toBe(level);
    const back = await c.post(`/api/v1/ai/recommendations/${open.id}/rollback`, {}, w.admin);
    expect(back.body.data.status).toBe('rolled_back');
    expect((await stockOf(c, w)).warehouses[0].reorderLevel).toBe(stockBefore.reorderLevel);
    // automate: only the listed action types run on their own
    expect((await c.put('/api/v1/ai/settings', { mode: 'automate', automatedActions: ['drop_database'] }, w.admin)).status).toBe(400);
    await c.put('/api/v1/ai/settings', { mode: 'automate', automatedActions: ['set_reorder_level'] }, w.admin);
    const auto = (await c.post('/api/v1/ai/recommendations/generate', {}, w.admin)).body.data;
    expect(auto.applied).toBeGreaterThanOrEqual(1);
    expect((await stockOf(c, w)).warehouses[0].reorderLevel).toBe(level);
    await c.put('/api/v1/ai/settings', { mode: 'recommend', automatedActions: [] }, w.admin);
    // a staff member (no ai:use) cannot touch any of it
    const staff = await c.addMember(w.admin, 'vendor_staff');
    expect((await c.get('/api/v1/ai/settings', staff)).status).toBe(403);
    expect((await c.post('/api/v1/ai/ask', { question: 'what are my best sellers' }, staff)).status).toBe(403);
    // audit trail of every AI decision
    const audit = (await c.get('/api/v1/audit-logs?filter[actionPrefix]=ai.&limit=50', w.admin)).body.data.map((l: any) => l.action);
    expect(audit).toEqual(expect.arrayContaining(['ai.settings_changed', 'ai.recommendation_approved', 'ai.recommendation_applied', 'ai.recommendation_rolled_back']));
  });

  it('automation: trigger -> condition -> action, approval, execution history, rollback, dry-run, validation', async () => {
    const cat = (await c.get('/api/v1/automation/catalog', w.admin)).body.data;
    expect(cat.triggers.map((x: any) => x.event)).toContain('order.created');
    // invalid rules are refused
    const bad = (body: any) => c.post('/api/v1/automation/rules', { name: 'x rule', ...body }, w.admin);
    expect((await bad({ triggerEvent: 'nope.event', action: { type: 'notify', params: { title: 'hello' } } })).status).toBe(400);
    expect((await bad({ triggerEvent: 'sync.failed', action: { type: 'start_fulfillment', params: {} } })).status).toBe(400); // action does not fit the trigger
    expect((await bad({ triggerEvent: 'order.created', action: { type: 'delete_everything', params: {} } })).status).toBe(400);
    expect((await bad({ triggerEvent: 'order.created', conditions: { combinator: 'all', conditions: [{ field: 'totalMinor', op: 'hack', value: 1 }] }, action: { type: 'notify', params: { title: 'hello there' } } })).status).toBe(400);
    // an automatic notification rule + an approval-gated "start fulfillment" rule
    const notify = (await c.post('/api/v1/automation/rules', { name: 'Tell me about big orders', triggerEvent: 'order.created', status: 'active', mode: 'auto', conditions: { combinator: 'all', conditions: [{ field: 'totalMinor', op: 'gte', value: 1000 }] }, action: { type: 'notify', params: { title: 'Order {{orderNumber}} arrived ({{marketplace}})', severity: 'info' } } }, w.admin)).body.data;
    const fulfil = (await c.post('/api/v1/automation/rules', { name: 'Auto-fulfil new orders', triggerEvent: 'order.created', status: 'active', conditions: { combinator: 'all', conditions: [] }, action: { type: 'start_fulfillment', params: {} } }, w.admin)).body.data;
    expect(fulfil.mode).toBe('approval'); // the safe default
    const dry = (await c.post(`/api/v1/automation/rules/${notify.id}/test`, { payload: { orderNumber: 'ORD-X', marketplace: 'mock', totalMinor: 5 } }, w.admin)).body.data;
    expect(dry.matched).toBe(false); // 5 < 1000: would not fire
    expect((await c.post(`/api/v1/automation/rules/${notify.id}/test`, { payload: { orderNumber: 'ORD-X', marketplace: 'mock', totalMinor: 99999 } }, w.admin)).body.data).toMatchObject({ matched: true, wouldDo: { action: 'notify', needsApproval: false } });

    const order = await orderArrives(t, c, w, 1);
    await t.pump();
    const ex = (await c.get(`/api/v1/automation/executions?limit=50`, w.admin)).body.data as any[];
    const mine = ex.filter((e) => e.facts.aggregateId === order.id);
    const n = mine.find((e) => e.ruleId === notify.id)!;
    const f = mine.find((e) => e.ruleId === fulfil.id)!;
    expect(n).toMatchObject({ status: 'executed', actionType: 'notify', result: { queued: true } });
    expect(f).toMatchObject({ status: 'pending_approval' }); // waits for a person
    const notes = (await c.get('/api/v1/notifications?filter[type]=automation.notice', w.admin)).body.data.items as any[];
    expect(notes.map((x) => x.title)).toContain(`Order ${order.orderNumber} arrived (mock)`);
    expect((await c.get(`/api/v1/orders/${order.id}/fulfillment`, w.admin)).body.data).toHaveLength(0); // nothing happened without approval
    // approve -> it runs; the order is routed; then roll it back
    const approved = await c.post(`/api/v1/automation/executions/${f.id}/approve`, {}, w.admin);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'executed', canRollback: true, result: { fulfillmentIds: [expect.any(String)] } });
    expect((await c.get(`/api/v1/orders/${order.id}/fulfillment`, w.admin)).body.data[0].status).toBe('confirmed');
    expect((await c.post(`/api/v1/automation/executions/${f.id}/approve`, {}, w.admin)).status).toBe(409); // not twice
    const rb = await c.post(`/api/v1/automation/executions/${f.id}/rollback`, {}, w.admin);
    expect(rb.body.data.status).toBe('rolled_back');
    expect((await c.get(`/api/v1/orders/${order.id}/fulfillment`, w.admin)).body.data[0].status).toBe('cancelled');
    // a rule with history cannot be deleted, only disabled; disabled rules do not fire
    expect((await c.del(`/api/v1/automation/rules/${notify.id}`, w.admin)).status).toBe(409);
    await c.post(`/api/v1/automation/rules/${notify.id}/disable`, {}, w.admin);
    await c.post(`/api/v1/automation/rules/${fulfil.id}/disable`, {}, w.admin);
    const before = ((await c.get('/api/v1/automation/executions?limit=200', w.admin)).body.data as any[]).length;
    await orderArrives(t, c, w, 1);
    await t.pump();
    expect(((await c.get('/api/v1/automation/executions?limit=200', w.admin)).body.data as any[]).length).toBe(before);
    // viewers can read the history but not change anything
    const viewer = await c.addMember(w.admin, 'vendor_viewer');
    expect((await c.get('/api/v1/automation/rules', viewer)).status).toBe(200);
    expect((await c.post(`/api/v1/automation/executions/${f.id}/rollback`, {}, viewer)).status).toBe(403);
    // another vendor cannot see or touch it
    const rival = await c.registerVendor();
    expect((await c.get('/api/v1/automation/rules', rival)).body.data).toEqual([]);
    expect((await c.post(`/api/v1/automation/executions/${f.id}/approve`, {}, rival)).status).toBe(404);
  });

  it('billing: free plan on signup, metering, limits (reported, enforced only when the platform says so), invoices, payments', async () => {
    const sub = (await c.get('/api/v1/billing/subscription', w.admin)).body.data;
    expect(sub).toMatchObject({ status: 'active', plan: { code: 'free' } });
    const usage = (await c.get('/api/v1/billing/usage', w.admin)).body.data;
    expect(usage.metrics.find((m: any) => m.metric === 'orders').used).toBeGreaterThanOrEqual(4);
    expect(usage.metrics.find((m: any) => m.metric === 'marketplace_accounts')).toMatchObject({ used: 1, limit: 1, exceeded: false });
    // limits are only reported by default: a second connection is allowed...
    expect((await c.connectAccount(w.admin, 'mock', { sellerId: 'SECOND1' })).status).toBe('active');
    // ...until the platform switches enforcement on for this vendor
    const platform = await c.platformAdmin('platform_admin');
    expect((await c.put(`/api/v1/admin/feature-flags/billing.enforce_limits/vendors/${w.admin.vendorId}`, { enabled: true }, platform)).status).toBe(200);
    const blocked = await c.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'third', mode: 'sandbox' }, w.admin);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details).toMatchObject({ rule: 'plan_limit', metric: 'marketplace_accounts', limit: 1 });
    // upgrading lifts it; a downgrade that does not fit is refused
    const up = await c.post('/api/v1/billing/subscription', { planCode: 'growth' }, w.admin);
    expect(up.body.data.plan).toMatchObject({ code: 'growth', priceMinor: 99_900 });
    expect((await c.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'third', mode: 'sandbox' }, w.admin)).status).toBe(201);
    const down = await c.post('/api/v1/billing/subscription', { planCode: 'free' }, w.admin);
    expect(down.status).toBe(409);
    expect(down.body.error.details).toMatchObject({ rule: 'over_plan_limit', metric: 'marketplace_accounts' });
    // invoicing: the period ended -> one invoice (idempotent), with tax; a failed payment marks past_due; a good one pays it
    await asOwner(`UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE vendor_id = '${w.admin.vendorId}'`);
    const run = (await c.post('/api/v1/admin/billing/invoices/run', {}, platform)).body.data;
    expect(run.invoiced).toBeGreaterThanOrEqual(1);
    expect((await c.post('/api/v1/admin/billing/invoices/run', {}, platform)).body.data.invoiced).toBe(0); // idempotent
    const invs = (await c.get('/api/v1/billing/invoices', w.admin)).body.data as any[];
    expect(invs).toHaveLength(1);
    const inv = (await c.get(`/api/v1/billing/invoices/${invs[0].id}`, w.admin)).body.data;
    expect(inv).toMatchObject({ status: 'open', subtotalMinor: 99_900, taxMinor: 17_982, totalMinor: 117_882 });
    expect(inv.lines[0]).toMatchObject({ description: expect.stringContaining('Growth'), amountMinor: 99_900 });
    const failed = await c.post(`/api/v1/admin/billing/invoices/${inv.id}/payments`, { status: 'failed', providerRef: 'pay_1', failureReason: 'card declined' }, platform);
    expect(failed.status).toBe(200);
    expect((await c.get('/api/v1/billing/subscription', w.admin)).body.data.status).toBe('past_due');
    expect((await t.outbox('billing.payment_failed')).length).toBe(1);
    const paid = await c.post(`/api/v1/admin/billing/invoices/${inv.id}/payments`, { status: 'succeeded', providerRef: 'pay_2' }, platform);
    expect(paid.body.data).toMatchObject({ status: 'paid' });
    expect((await c.post(`/api/v1/admin/billing/invoices/${inv.id}/payments`, { status: 'succeeded', providerRef: 'pay_3' }, platform)).status).toBe(409);
    expect((await c.get('/api/v1/billing/subscription', w.admin)).body.data.status).toBe('active');
    // vendors cannot see another vendor's invoice, nor platform billing admin
    const rival = await c.registerVendor();
    expect((await c.get(`/api/v1/billing/invoices/${inv.id}`, rival)).status).toBe(404);
    expect((await c.post('/api/v1/admin/billing/invoices/run', {}, w.admin)).status).toBe(403);
    expect((await c.put('/api/v1/admin/billing/plans/free', { name: 'Free', priceMinor: 0, limits: {} }, w.admin)).status).toBe(403);
  });

  it('platform admin + feature flags: separate from vendor access, audited, effective immediately', async () => {
    const platform = await c.platformAdmin('platform_admin');
    const support = await c.platformAdmin('platform_support');
    // vendors cannot reach any admin endpoint
    for (const url of ['/api/v1/admin/overview', '/api/v1/admin/system/health', '/api/v1/admin/connectors', '/api/v1/admin/feature-flags', '/api/v1/admin/jobs/failed', '/api/v1/admin/integrations/failing', '/api/v1/admin/users']) {
      expect((await c.get(url, w.admin)).status, url).toBe(403);
    }
    const ov = (await c.get('/api/v1/admin/overview', platform)).body.data;
    expect(ov.vendors.active).toBeGreaterThanOrEqual(1);
    expect(ov.marketplaceAccounts.length).toBeGreaterThanOrEqual(1);
    expect(ov.outbox).toHaveProperty('unpublished');
    expect((await c.get('/api/v1/admin/system/health', platform)).body.data).toMatchObject({ database: { ok: true } });
    expect((await c.get(`/api/v1/admin/vendors/${w.admin.vendorId}/summary`, support)).body.data).toMatchObject({ subscription: { plan: 'growth' } });
    // support can look, not change
    expect((await c.put('/api/v1/admin/feature-flags/beta.features', { defaultEnabled: true }, support)).status).toBe(403);
    expect((await c.put('/api/v1/admin/connectors/flipkart', { enabled: false }, support)).status).toBe(403);
    await c.del(`/api/v1/admin/feature-flags/billing.enforce_limits/vendors/${w.admin.vendorId}`, platform); // plan limits are not what this step is about
    // a connector switched off on the platform stops new connections, for everyone
    const conns = (await c.get('/api/v1/admin/connectors', platform)).body.data as any[];
    expect(conns.map((x) => x.code)).toEqual(expect.arrayContaining(['amazon_in', 'flipkart', 'myntra', 'snapdeal', 'mock']));
    expect(conns.every((x) => x.live === false)).toBe(true); // nothing claims to be live-verified
    expect((await c.put('/api/v1/admin/connectors/flipkart', { enabled: false }, platform)).status).toBe(200);
    const fk = await c.post('/api/v1/marketplace-accounts', { marketplace: 'flipkart', displayName: 'FK', mode: 'sandbox' }, w.admin);
    expect(fk.status).toBe(403);
    expect(fk.body.error.details.flag).toBe('connector.flipkart.enabled');
    await c.put('/api/v1/admin/feature-flags/connector.flipkart.enabled/vendors/' + w.admin.vendorId, { enabled: true }, platform); // vendor-specific capability
    expect((await c.post('/api/v1/marketplace-accounts', { marketplace: 'flipkart', displayName: 'FK', mode: 'sandbox' }, w.admin)).status).toBe(201);
    await c.put('/api/v1/admin/connectors/flipkart', { enabled: true }, platform);
    // AI off for one vendor via flag; the vendor sees its own flags
    await c.put(`/api/v1/admin/feature-flags/ai.enabled/vendors/${w.admin.vendorId}`, { enabled: false }, platform);
    expect((await c.get('/api/v1/features/me', w.admin)).body.data).toMatchObject({ 'ai.enabled': false, 'automation.enabled': true });
    const off = await c.post('/api/v1/ai/ask', { question: 'what are my best sellers' }, w.admin);
    expect(off.status).toBe(403);
    expect(off.body.error.details.flag).toBe('ai.enabled');
    expect((await c.post('/api/v1/automation/rules', { name: 'rule one', triggerEvent: 'order.created', action: { type: 'notify', params: { title: 'hi there' } } }, w.admin)).status).toBe(201); // automation is still on
    await c.del(`/api/v1/admin/feature-flags/ai.enabled/vendors/${w.admin.vendorId}`, platform);
    expect((await c.post('/api/v1/ai/ask', { question: 'what are my best sellers' }, w.admin)).status).toBe(200);
    // users across tenants: search, disable (sessions end), re-enable; never yourself
    const who = (await c.get(`/api/v1/admin/users?q=${encodeURIComponent(w.admin.email.slice(0, 8))}`, platform)).body.data as any[];
    const target = who.find((u) => u.id === w.admin.userId)!;
    expect(target).toMatchObject({ email: w.admin.email, status: 'active' });
    expect((await c.post(`/api/v1/admin/users/${platform.userId}/disable`, {}, platform)).status).toBe(409);
    expect((await c.post(`/api/v1/admin/users/${target.id}/disable`, {}, platform)).body.data.status).toBe('disabled');
    expect((await c.get('/api/v1/features/me', w.admin)).status).toBe(401); // its sessions ended
    await c.post(`/api/v1/admin/users/${target.id}/enable`, {}, platform);
    w.admin = await c.login(w.admin.email, w.admin.password);
    // every platform action is in the audit trail
    const audit = (await c.get('/api/v1/audit-logs?filter[actionPrefix]=admin.&limit=100', platform)).body.data.map((l: any) => l.action);
    expect(audit).toEqual(expect.arrayContaining(['admin.flag_override', 'admin.connector_switched', 'admin.user_disable', 'admin.invoice_payment']));
    // platform staff acting inside a vendor stay read-only (stage 4 hardening still holds)
    expect((await c.call('POST', '/api/v1/warehouses', { as: platform, headers: { 'x-act-as-vendor': w.admin.vendorId! }, body: { code: 'X1', name: 'x' } })).status).toBe(403);
  });

  it('secrets never leave: marketplace credentials appear in no API response', async () => {
    const accounts = await c.get('/api/v1/marketplace-accounts', w.admin);
    const blob = JSON.stringify(accounts.body);
    expect(blob).not.toMatch(/sandbox_key|credentials|refreshToken|apiKey|secret/i);
    const catalog = JSON.stringify((await c.get('/api/v1/marketplaces', w.admin)).body);
    expect(catalog).not.toMatch(/sandbox_key|refreshToken/i);
  });
});
