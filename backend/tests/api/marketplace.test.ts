import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, mockControl, PROD_SAFE_ENV, type Actor, type TestApp } from '@oms/testing';

let t: TestApp;
let c: ReturnType<typeof clientFor>;
let admin: Actor;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
  admin = await c.registerVendor({ businessName: 'Market Co' });
});
beforeEach(() => mockControl.reset());
afterAll(() => t.close());

const newAccount = async (as: Actor = admin, marketplace = 'mock', displayName = 'Sandbox') => (await c.post('/api/v1/marketplace-accounts', { marketplace, displayName }, as)).body.data;
const connect = async (id: string, seller = `SELLER-${Math.random().toString(36).slice(2, 8)}`, as: Actor = admin) =>
  c.post(`/api/v1/marketplace-accounts/${id}/authorize`, { credentials: { sellerId: seller, apiKey: 'sandbox_key' } }, as);
/** Reads what is actually stored (as the table owner) to prove secrets are encrypted at rest. */
const storedAuthorizations = async () => {
  const pg = t.database!.pg;
  await pg.exec('RESET ROLE');
  const { rows } = await pg.query<{ credentials_ciphertext: string; encryption_key_id: string }>('select credentials_ciphertext, encryption_key_id from marketplace_authorizations');
  await pg.exec('SET ROLE oms_app');
  return rows;
};

describe('connector catalogue and capability matrix', () => {
  it('lists every marketplace with capabilities (not all marketplaces are equal)', async () => {
    const r = await c.get('/api/v1/marketplaces', admin);
    expect(r.status).toBe(200);
    const byCode = Object.fromEntries(r.body.data.map((m: any) => [m.code, m]));
    expect(Object.keys(byCode).sort()).toEqual(['amazon_in', 'flipkart', 'mock', 'myntra', 'snapdeal']);
    expect(byCode.mock).toMatchObject({ implementation: 'beta', redirectFlow: true });
    expect(byCode.mock.enabledCapabilities).toEqual(expect.arrayContaining(['orders.fetch', 'inventory.push', 'listings.create', 'shipping.createShipment', 'catalog.import']));
    // every launch connector is implemented against its sandbox/simulator; none is verified for LIVE use yet
    for (const code of ['amazon_in', 'flipkart', 'myntra', 'snapdeal']) expect(byCode[code].implementation).toBe('beta');
    // differences are real: Amazon updates one SKU per call, Flipkart/Myntra/Snapdeal batch; only some marketplaces push webhooks or accept cancellations
    expect(byCode.amazon_in.capabilities.auth.type).toBe('oauth2_lwa');
    expect(byCode.amazon_in.capabilities.inventory.batch).toBe(false);
    expect(byCode.flipkart.capabilities.inventory.batch).toBe(true);
    expect(byCode.myntra.enabledCapabilities).not.toContain('orders.webhook');
    expect(byCode.flipkart.enabledCapabilities).toContain('orders.webhook');
    expect(byCode.snapdeal.capabilities.auth.refreshable).toBe(false);
    expect((await c.get('/api/v1/marketplaces/flipkart', admin)).body.data.code).toBe('flipkart');
    expect((await c.get('/api/v1/marketplaces/ebay', admin)).status).toBe(404);
  });

  it('a vendor may hold several accounts, including several on the same marketplace', async () => {
    const one = await newAccount(admin, 'mock', 'First');
    const two = await newAccount(admin, 'mock', 'Second');
    const fk = await newAccount(admin, 'flipkart', 'Flipkart main');
    expect(new Set([one.id, two.id, fk.id]).size).toBe(3);
    const mine = await c.get('/api/v1/marketplace-accounts?filter[marketplace]=flipkart', admin);
    expect(mine.body.data.map((a: any) => a.displayName)).toEqual(['Flipkart main']);
    expect((await c.get(`/api/v1/marketplace-accounts/${fk.id}/capabilities`, admin)).body.data.code).toBe('flipkart');
  });

  it('refuses unknown marketplaces and never fakes live access for a connector that is not verified', async () => {
    expect((await c.post('/api/v1/marketplace-accounts', { marketplace: 'ebay', displayName: 'Ebay' }, admin)).status).toBe(404);
    const amazon = await newAccount(admin, 'amazon_in', 'Amazon IN');
    expect(amazon).toMatchObject({ mode: 'live', status: 'pending_authorization' });
    const r = await c.post(`/api/v1/marketplace-accounts/${amazon.id}/authorize`, { credentials: { refreshToken: 'x' } }, admin);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', details: { marketplace: 'amazon_in', reason: 'live_not_verified' } });
  });

  it('the mock marketplace is sandbox-only and can be switched off (production default)', async () => {
    expect((await c.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'Mock', mode: 'live' }, admin)).status).toBe(400);
    const prodLike = await buildTestApp({ database: true, config: { ...PROD_SAFE_ENV, MOCK_MARKETPLACE_ENABLED: 'false', SWAGGER_ENABLED: 'false' } });
    const cc = clientFor(prodLike);
    const actor = await cc.registerVendor();
    expect((await cc.get('/api/v1/marketplaces', actor)).body.data.map((m: any) => m.code)).not.toContain('mock');
    expect((await cc.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'Mock' }, actor)).status).toBe(404);
    await prodLike.close();
  });
});

describe('authorization (connect)', () => {
  it('connects with credentials; token metadata is exposed, secrets are not, and they are encrypted at rest', async () => {
    const acct = await newAccount();
    const r = await connect(acct.id, 'ENC-SELLER');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      status: 'active', connectionStatus: 'connected', externalAccountId: 'ENC-SELLER', lastFailureAt: null,
      authorization: { status: 'active', authType: 'oauth2', rotationCount: 0, scopes: expect.arrayContaining(['orders']) },
    });
    expect(r.body.data.authorization.accessTokenExpiresAt).toBeTruthy();
    const everything = JSON.stringify([r.body, (await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body, (await c.get('/api/v1/marketplace-accounts', admin)).body]);
    expect(everything).not.toMatch(/sandbox_key|mock_at_|mock_rt_|"accessToken"|"refreshToken"|"credentials"|ciphertext/i);

    const stored = (await storedAuthorizations()).at(-1)!;
    expect(stored.credentials_ciphertext).toMatch(/^v1\.test\./);
    expect(stored.credentials_ciphertext).not.toMatch(/sandbox_key|mock_at_|mock_rt_|ENC-SELLER/);
  });

  it('redirect flow: signed state is required and bound to the account; bad codes and keys are rejected', async () => {
    const a1 = await newAccount();
    const a2 = await newAccount();
    const start = await c.get(`/api/v1/marketplace-accounts/${a1.id}/authorization-url?redirectUri=${encodeURIComponent('https://app.example.com/callback')}`, admin);
    expect(start.status).toBe(200);
    const url = new URL(start.body.data.authorizationUrl);
    expect(url.searchParams.get('state')).toBe(start.body.data.state);
    const { state } = start.body.data;

    expect((await c.post(`/api/v1/marketplace-accounts/${a1.id}/authorize`, { code: 'sandbox-code:FLOW-1', state: 'x'.repeat(20) }, admin)).status).toBe(400);
    expect((await c.post(`/api/v1/marketplace-accounts/${a2.id}/authorize`, { code: 'sandbox-code:FLOW-1', state }, admin)).status).toBe(400); // state of another account
    expect((await c.post(`/api/v1/marketplace-accounts/${a1.id}/authorize`, { code: 'sandbox-code:FLOW-1' }, admin)).status).toBe(400); // state missing
    const bad = await c.post(`/api/v1/marketplace-accounts/${a1.id}/authorize`, { code: 'wrong-code', state }, admin);
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const ok = await c.post(`/api/v1/marketplace-accounts/${a1.id}/authorize`, { code: 'sandbox-code:FLOW-1', state, redirectUri: 'https://app.example.com/callback' }, admin);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'active', externalAccountId: 'FLOW-1' });
    // a failed attempt is visible on the account
    expect((await c.get(`/api/v1/marketplace-accounts/${a1.id}`, admin)).body.data.lastFailureAt).toBeTruthy();
  });

  it('rejects invalid sandbox credentials without storing anything', async () => {
    const acct = await newAccount();
    const before = (await storedAuthorizations()).length;
    const r = await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { credentials: { sellerId: 'S', apiKey: 'live_key_not_allowed' } }, admin);
    expect(r.status).toBe(401);
    expect((await storedAuthorizations()).length).toBe(before);
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data).toMatchObject({ status: 'pending_authorization', authorization: null });
  });

  it('validates the request shape (code XOR credentials)', async () => {
    const acct = await newAccount();
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, {}, admin)).status).toBe(400);
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { code: 'x', state: 'y'.repeat(20), credentials: {} }, admin)).status).toBe(400);
  });

  it('the same seller handle cannot be connected twice by one vendor on one marketplace', async () => {
    const a1 = await newAccount();
    const a2 = await newAccount();
    expect((await connect(a1.id, 'DUP-SELLER')).status).toBe(200);
    const dup = await connect(a2.id, 'DUP-SELLER');
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.field).toBe('externalAccountId');
  });

  it('requires a verified e-mail address and the marketplace_accounts:write permission', async () => {
    const unverified = await c.registerVendor({ verify: false });
    const acct = await newAccount(unverified);
    const r = await connect(acct.id, 'UNVER', unverified);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    const staff = await c.addMember(admin, 'vendor_staff');
    const own = await newAccount();
    expect((await connect(own.id, 'STAFF-TRY', staff)).status).toBe(403);
  });
});

describe('credential lifecycle: rotation, expiry, health, reconnect, disconnect', () => {
  it('manual refresh rotates the tokens (stored re-encrypted, rotationCount increments)', async () => {
    const acct = await newAccount();
    await connect(acct.id);
    const before = (await storedAuthorizations()).at(-1)!.credentials_ciphertext;
    const r = await c.post(`/api/v1/marketplace-accounts/${acct.id}/refresh`, {}, admin);
    expect(r.status).toBe(200);
    expect(r.body.data.authorization).toMatchObject({ rotationCount: 1, status: 'active' });
    expect((await storedAuthorizations()).at(-1)!.credentials_ciphertext).not.toBe(before);
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/refresh`, {}, admin)).body.data.authorization.rotationCount).toBe(2);
  });

  it('an expired access token is refreshed transparently and the call is retried once', async () => {
    const acct = await newAccount();
    await connect(acct.id, 'EXP-SELLER');
    mockControl.expireAllAccessTokens(); // the marketplace now rejects the stored access token
    const r = await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-products?limit=3`, admin);
    expect(r.status).toBe(200);
    expect(r.body.data.items).toHaveLength(3);
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data.authorization.rotationCount).toBe(1);
  });

  it('a token that is about to expire is refreshed BEFORE the call (proactive rotation)', async () => {
    const acct = await newAccount();
    const start = await c.get(`/api/v1/marketplace-accounts/${acct.id}/authorization-url?redirectUri=${encodeURIComponent('https://app.example.com/cb')}`, admin);
    await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { code: 'sandbox-code:SHORT-1:30', state: start.body.data.state }, admin); // 30 s lifetime < 2 min refresh window
    const calls = mockControl.calls('SHORT-1');
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin)).status).toBe(200);
    const detail = (await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data;
    expect(detail.authorization.rotationCount).toBe(1);
    expect(mockControl.calls('SHORT-1')).toBeGreaterThan(calls);
  });

  it('the scheduled maintenance job rotates tokens that are close to expiry (and only those)', async () => {
    const soon = await newAccount(admin, 'mock', 'Expiring soon');
    const later = await newAccount(admin, 'mock', 'Fresh');
    const start = await c.get(`/api/v1/marketplace-accounts/${soon.id}/authorization-url?redirectUri=${encodeURIComponent('https://app.example.com/cb')}`, admin);
    await c.post(`/api/v1/marketplace-accounts/${soon.id}/authorize`, { code: 'sandbox-code:MAINT-1:300', state: start.body.data.state }, admin); // 5 min left
    await connect(later.id, 'MAINT-2'); // 1 h left
    await t.queues.enqueue('maintenance', 'marketplace.refresh-expiring-tokens', { vendorId: null, correlationId: 'sched', data: {} });
    await t.runJobs((j) => j.name === 'marketplace.refresh-expiring-tokens');
    expect((await c.get(`/api/v1/marketplace-accounts/${soon.id}`, admin)).body.data.authorization.rotationCount).toBe(1);
    expect((await c.get(`/api/v1/marketplace-accounts/${later.id}`, admin)).body.data.authorization.rotationCount).toBe(0);
  });

  it('transient errors and 429s are retried with backoff and succeed', async () => {
    const acct = await newAccount();
    await connect(acct.id, 'RETRY-1');
    mockControl.setBehavior('RETRY-1', { failNext: 2, failKind: 'transient' });
    const before = mockControl.calls('RETRY-1');
    const r = await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin);
    expect(r.status).toBe(200);
    expect(mockControl.calls('RETRY-1') - before).toBe(3); // 2 failures + 1 success

    mockControl.setBehavior('RETRY-1', { rateLimitNext: 1, retryAfterMs: 20 });
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin)).status).toBe(200);
  });

  it('retries are bounded: persistent failures surface as 502 and are recorded on the account', async () => {
    const acct = await newAccount();
    await connect(acct.id, 'RETRY-2');
    mockControl.setBehavior('RETRY-2', { failNext: 10, failKind: 'transient' });
    const before = mockControl.calls('RETRY-2');
    const r = await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({ code: 'UPSTREAM_ERROR', details: { marketplace: 'mock', kind: 'transient' } });
    expect(mockControl.calls('RETRY-2') - before).toBe(3);
    const detail = (await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data;
    expect(detail).toMatchObject({ connectionStatus: 'degraded', status: 'active' });
    expect(detail.lastFailureAt).toBeTruthy();
    expect(detail.lastFailureMessage).toMatch(/Simulated transient/);
    // permanent errors are never retried
    mockControl.setBehavior('RETRY-2', { failNext: 5, failKind: 'permanent' });
    const calls = mockControl.calls('RETRY-2');
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin)).status).toBe(502);
    expect(mockControl.calls('RETRY-2') - calls).toBe(1);
  });

  it('health-check reports problems in the body instead of failing, and recovers', async () => {
    const acct = await newAccount();
    await connect(acct.id, 'HEALTH-1');
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, admin)).body.data).toMatchObject({ ok: true, connectionStatus: 'connected' });
    mockControl.setBehavior('HEALTH-1', { failNext: 10, failKind: 'transient' });
    const bad = await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, admin);
    expect(bad.status).toBe(200);
    expect(bad.body.data).toMatchObject({ ok: false, connectionStatus: 'degraded' });
    mockControl.setBehavior('HEALTH-1', {});
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, admin)).body.data).toMatchObject({ ok: true, connectionStatus: 'connected' });
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data.lastSuccessAt).toBeTruthy();
  });

  it('when the marketplace rejects the credentials for good, the authorization expires and reconnect fixes it', async () => {
    const acct = await newAccount();
    await connect(acct.id, 'AUTHFAIL-1');
    mockControl.setBehavior('AUTHFAIL-1', { failNext: 10, failKind: 'auth' }); // access AND refresh keep failing
    const r = await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin);
    expect(r.status).toBe(502);
    expect(r.body.error.details).toMatchObject({ kind: 'auth', action: 'reconnect' });
    const broken = (await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data;
    expect(broken).toMatchObject({ status: 'error', connectionStatus: 'error', authorization: { status: 'expired' } });
    expect(broken.authorization.lastErrorCode).toBeTruthy();
    // no more marketplace calls while broken
    const calls = mockControl.calls('AUTHFAIL-1');
    const blocked = await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ACCOUNT_NOT_CONNECTED');
    expect(mockControl.calls('AUTHFAIL-1')).toBe(calls);
    // the failure was published for notifications
    const pg = t.database!.pg;
    await pg.exec('RESET ROLE'); // read as owner: outbox rows are tenant-scoped (RLS) and this assertion is cross-tenant
    const events = await pg.query<{ type: string }>("select type from outbox_events where type = 'marketplace_account.authorization_expired' and aggregate_id = $1", [acct.id]);
    await pg.exec('SET ROLE oms_app');
    expect(events.rows.length).toBe(1);

    mockControl.setBehavior('AUTHFAIL-1', {});
    const fixed = await c.post(`/api/v1/marketplace-accounts/${acct.id}/reconnect`, { credentials: { sellerId: 'AUTHFAIL-1', apiKey: 'sandbox_new' } }, admin);
    expect(fixed.status).toBe(200);
    expect(fixed.body.data).toMatchObject({ status: 'active', connectionStatus: 'connected', authorization: { status: 'active', lastErrorCode: null } });
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin)).status).toBe(200);
  });

  it('disconnect destroys the stored credentials; deleting needs a disconnected account', async () => {
    const acct = await newAccount();
    await connect(acct.id, 'DISC-1');
    expect((await c.del(`/api/v1/marketplace-accounts/${acct.id}`, admin)).status).toBe(409); // still connected
    const before = (await storedAuthorizations()).length;
    const r = await c.post(`/api/v1/marketplace-accounts/${acct.id}/disconnect`, {}, admin);
    expect(r.body.data).toMatchObject({ status: 'revoked', connectionStatus: 'disconnected', authorization: null });
    expect((await storedAuthorizations()).length).toBe(before - 1);
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-products`, admin)).status).toBe(409);
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, admin)).body.data.ok).toBe(false);
    // reconnect after disconnect
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/reconnect`, { credentials: { sellerId: 'DISC-1', apiKey: 'sandbox_k2' } }, admin)).body.data.status).toBe('active');
    await c.post(`/api/v1/marketplace-accounts/${acct.id}/disconnect`, {}, admin);
    expect((await c.del(`/api/v1/marketplace-accounts/${acct.id}`, admin)).status).toBe(200);
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).status).toBe(404);
  });

  it('pause blocks marketplace calls; resume restores them; pending accounts cannot be paused', async () => {
    const acct = await newAccount();
    expect((await c.patch(`/api/v1/marketplace-accounts/${acct.id}`, { status: 'paused' }, admin)).status).toBe(409);
    await connect(acct.id, 'PAUSE-1');
    expect((await c.patch(`/api/v1/marketplace-accounts/${acct.id}`, { status: 'paused' }, admin)).body.data.status).toBe('paused');
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin)).status).toBe(409);
    expect((await c.patch(`/api/v1/marketplace-accounts/${acct.id}`, { status: 'active', displayName: 'Renamed' }, admin)).body.data).toMatchObject({ status: 'active', displayName: 'Renamed' });
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin)).status).toBe(200);
  });

  it('capability-gated reads return the normalised sandbox data (account profile, catalogue paging)', async () => {
    const acct = await newAccount();
    await connect(acct.id, 'CAT-1');
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin)).body.data).toMatchObject({ externalAccountId: 'CAT-1', status: 'active' });
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: any = await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-products?limit=10${cursor ? `&cursor=${cursor}` : ''}`, admin);
      page.body.data.items.forEach((i: any) => seen.add(i.externalSku));
      cursor = page.body.data.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(25);
  });
});
