import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { amazonControl, buildTestApp, clientFor, flipkartControl, mockControl, myntraControl, snapdealControl, type Actor, type TestApp } from '@oms/testing';

/**
 * Marketplace connection lifecycle for every launch connector: connect -> authorize -> credential/token storage -> health
 * -> test -> disconnect -> reconnect. Independent per vendor; one connector instance serves many vendors.
 */
let t: TestApp;
let c: ReturnType<typeof clientFor>;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
});
afterAll(() => t.close());

const MARKETS = [
  { code: 'mock', control: mockControl as { setBehavior: (s: string, b: object) => void; expireAllAccessTokens?: () => void }, expire: () => mockControl.expireAllAccessTokens(), refreshable: true, redirect: false },
  { code: 'amazon_in', control: amazonControl, expire: () => amazonControl.expireTokens(), refreshable: true, redirect: true },
  { code: 'flipkart', control: flipkartControl, expire: () => flipkartControl.expireTokens(), refreshable: true, redirect: true },
  { code: 'myntra', control: myntraControl, expire: () => myntraControl.expireTokens(), refreshable: true, redirect: false },
  { code: 'snapdeal', control: snapdealControl, expire: () => undefined, refreshable: false, redirect: false },
] as const;

const creds = (code: string, seller: string): Record<string, string> => ({
  mock: { sellerId: seller, apiKey: 'sandbox_key' }, amazon_in: { sellerId: seller, refreshToken: `Atzr|sandbox:${seller}` }, flipkart: { appId: `fk-sandbox-${seller}`, appSecret: 'secret' },
  myntra: { apiKey: `myn-sandbox-${seller}`, apiSecret: 'secret' }, snapdeal: { sellerId: seller, authToken: `sd-sandbox-${seller}` },
}[code]!);
const account = async (as: Actor, code: string, mode: 'sandbox' | 'live' = 'sandbox') => (await c.post('/api/v1/marketplace-accounts', { marketplace: code, displayName: `${code} acct`, mode }, as)).body.data;
const storedCiphertexts = async () => {
  const pg = t.database!.pg;
  await pg.exec('RESET ROLE');
  const { rows } = await pg.query<{ credentials_ciphertext: string }>('select credentials_ciphertext from marketplace_authorizations');
  await pg.exec('SET ROLE oms_app');
  return rows.map((r) => r.credentials_ciphertext);
};

describe.each(MARKETS)('connection lifecycle: $code', (m) => {
  let admin: Actor;
  const seller = `CONN${m.code.replace('_', '').toUpperCase()}`;

  it('connect -> authorize -> health -> test -> disconnect -> reconnect', async () => {
    admin = await c.registerVendor({ businessName: `Conn ${m.code}` });
    const acct = await account(admin, m.code);
    expect(acct).toMatchObject({ status: 'pending_authorization', mode: 'sandbox', authorization: null });

    // authorize: the marketplace validates the credentials BEFORE we store anything
    const auth = await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { credentials: creds(m.code, seller) }, admin);
    expect(auth.status, JSON.stringify(auth.body)).toBe(200);
    expect(auth.body.data).toMatchObject({ status: 'active', connectionStatus: 'connected', externalAccountId: seller, authorization: { status: 'active', rotationCount: 0 } });
    if (m.refreshable) expect(auth.body.data.authorization.accessTokenExpiresAt).toBeTruthy();
    // credential storage: encrypted at rest, never returned, never logged in the API payload
    const body = JSON.stringify(auth.body);
    for (const secret of Object.values(creds(m.code, seller))) if (secret.length > 6 && secret !== seller) expect(body).not.toContain(secret);
    const stored = await storedCiphertexts();
    expect(stored.length).toBeGreaterThan(0);
    for (const ct of stored) for (const secret of Object.values(creds(m.code, seller))) expect(ct).not.toContain(secret);

    const health = await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, admin);
    expect(health.body.data).toMatchObject({ ok: true, connectionStatus: 'connected' });

    const test = await c.post(`/api/v1/marketplace-accounts/${acct.id}/test`, {}, admin);
    expect(test.status, JSON.stringify(test.body)).toBe(200);
    expect(test.body.data).toMatchObject({ ok: true, marketplace: m.code, mode: 'sandbox' });
    expect(test.body.data.steps.map((s: any) => s.name)).toEqual(['credentials', 'profile', 'catalog', 'orders']);
    expect(test.body.data.steps.every((s: any) => s.ok)).toBe(true);
    expect(test.body.data.steps.find((s: any) => s.name === 'profile').message).toContain(seller);

    const remote = await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-account`, admin);
    expect(remote.body.data.externalAccountId).toBe(seller);

    // disconnect destroys the credentials; every call is refused until reconnected
    const off = await c.post(`/api/v1/marketplace-accounts/${acct.id}/disconnect`, {}, admin);
    expect(off.body.data).toMatchObject({ status: 'revoked', connectionStatus: 'disconnected', authorization: null });
    const refused = await c.post(`/api/v1/marketplace-accounts/${acct.id}/test`, {}, admin);
    expect(refused.body.data.ok).toBe(false);
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/remote-products`, admin)).body.error.code).toBe('ACCOUNT_NOT_CONNECTED');

    const back = await c.post(`/api/v1/marketplace-accounts/${acct.id}/reconnect`, { credentials: creds(m.code, seller) }, admin);
    expect(back.status).toBe(200);
    expect(back.body.data).toMatchObject({ status: 'active', connectionStatus: 'connected' });
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/test`, {}, admin)).body.data.ok).toBe(true);
    expect((await t.outbox('marketplace_account.connected')).filter((e) => e.vendorId === admin.vendorId)).toHaveLength(2);
  });

  it('rejects bad credentials with a clear error and stores nothing', async () => {
    const a = await c.registerVendor({ businessName: `Bad ${m.code}` });
    const acct = await account(a, m.code);
    const bad = Object.fromEntries(Object.entries(creds(m.code, seller)).map(([k]) => [k, 'definitely-wrong']));
    const r = await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { credentials: bad }, a);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    const after = (await c.get(`/api/v1/marketplace-accounts/${acct.id}`, a)).body.data;
    expect(after).toMatchObject({ status: 'pending_authorization', authorization: null });
  });

  it('refreshes tokens on its own when the access token expires (where tokens expire)', async () => {
    const a = await c.registerVendor({ businessName: `Refresh ${m.code}` });
    const acct = await account(a, m.code);
    await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { credentials: creds(m.code, `${seller}R`) }, a);
    m.expire();
    const health = await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, a);
    expect(health.body.data.ok).toBe(true);
    const after = (await c.get(`/api/v1/marketplace-accounts/${acct.id}`, a)).body.data;
    expect(after.authorization.rotationCount).toBe(m.refreshable ? 1 : 0);
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/refresh`, {}, a)).status).toBe(m.refreshable ? 200 : 422);
  });

  it('absorbs rate limiting and brief outages during calls', async () => {
    const a = await c.registerVendor({ businessName: `Flaky ${m.code}` });
    const acct = await account(a, m.code);
    const s = `${seller}F`;
    await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { credentials: creds(m.code, s) }, a);
    if (m.code === 'mock') (m.control as { setBehavior: (s: string, b: object) => void }).setBehavior(s, { rateLimitNext: 1, retryAfterMs: 1 });
    else (m.control as typeof amazonControl).setBehavior(s, { rateLimitNext: 1, retryAfterSec: 0 });
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, a)).body.data.ok).toBe(true);
    if (m.code === 'mock') (m.control as { setBehavior: (s: string, b: object) => void }).setBehavior(s, { failNext: 1, failKind: 'transient' });
    else (m.control as typeof amazonControl).setBehavior(s, { failNext: 1, failStatus: 503 });
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, a)).body.data.ok).toBe(true);
    // a persistent outage degrades the connection, it does not disconnect it
    if (m.code === 'mock') (m.control as { setBehavior: (s: string, b: object) => void }).setBehavior(s, { failNext: 100, failKind: 'transient' });
    else (m.control as typeof amazonControl).setBehavior(s, { failNext: 100, failStatus: 503 });
    const down = await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, a);
    expect(down.body.data).toMatchObject({ ok: false, connectionStatus: 'degraded' });
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, a)).body.data).toMatchObject({ status: 'active', lastFailureMessage: expect.any(String) });
  });

  it('is never connected LIVE: the connector has not been verified against the real marketplace', async () => {
    if (m.code === 'mock') return; // the mock is sandbox-only by construction
    const a = await c.registerVendor({ businessName: `Live ${m.code}` });
    const acct = await account(a, m.code, 'live');
    expect(acct.mode).toBe('live');
    const r = await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { credentials: creds(m.code, seller) }, a);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', details: { marketplace: m.code, reason: 'live_not_verified' } });
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, a)).body.data.authorization).toBeNull();
  });

  it('serves many vendors independently: one vendor disconnecting or failing never affects another', async () => {
    const [a, b] = [await c.registerVendor({ businessName: `Ind A ${m.code}` }), await c.registerVendor({ businessName: `Ind B ${m.code}` })];
    const [accA, accB] = [await account(a, m.code), await account(b, m.code)];
    await c.post(`/api/v1/marketplace-accounts/${accA.id}/authorize`, { credentials: creds(m.code, `${seller}A`) }, a);
    await c.post(`/api/v1/marketplace-accounts/${accB.id}/authorize`, { credentials: creds(m.code, `${seller}B`) }, b);
    expect((await c.get(`/api/v1/marketplace-accounts/${accA.id}`, b)).status).toBe(404);
    expect((await c.post(`/api/v1/marketplace-accounts/${accA.id}/test`, {}, b)).status).toBe(404);
    await c.post(`/api/v1/marketplace-accounts/${accA.id}/disconnect`, {}, a);
    expect((await c.post(`/api/v1/marketplace-accounts/${accB.id}/test`, {}, b)).body.data.ok).toBe(true);
    expect((await c.get(`/api/v1/marketplace-accounts/${accB.id}`, b)).body.data).toMatchObject({ status: 'active', externalAccountId: `${seller}B` });
  });
});

describe.each(MARKETS.filter((m) => m.redirect))('redirect authorization: $code', (m) => {
  it('builds a consent URL with a signed state, and exchanges the returned code', async () => {
    const admin = await c.registerVendor({ businessName: `Redirect ${m.code}` });
    const acct = await account(admin, m.code);
    const url = await c.get(`/api/v1/marketplace-accounts/${acct.id}/authorization-url?redirectUri=${encodeURIComponent('https://app.example.test/callback')}`, admin);
    expect(url.status).toBe(200);
    expect(url.body.data.expiresInSeconds).toBe(600);
    const consent = new URL(url.body.data.authorizationUrl);
    expect(consent.searchParams.get('state')).toBe(url.body.data.state);

    const seller = `REDIR${m.code.toUpperCase().replace('_', '')}`;
    const code = m.code === 'amazon_in' ? `ANsandbox:${seller}` : `FKsandbox:${seller}`;
    // a forged / foreign state is refused before anything reaches the marketplace
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { code, state: 'forged-state-value-123', externalAccountId: seller }, admin)).status).toBe(400);
    const ok = await c.post(`/api/v1/marketplace-accounts/${acct.id}/authorize`, { code, state: url.body.data.state, redirectUri: 'https://app.example.test/callback', externalAccountId: seller }, admin);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'active', externalAccountId: seller, authorization: { status: 'active' } });
    // the state is bound to the account: it cannot be replayed on another account of the same vendor
    const other = await account(admin, m.code);
    expect((await c.post(`/api/v1/marketplace-accounts/${other.id}/authorize`, { code, state: url.body.data.state, externalAccountId: seller }, admin)).status).toBe(400);
    // a wrong code is an authentication failure
    const wrong = await account(admin, m.code);
    const wrongState = (await c.get(`/api/v1/marketplace-accounts/${wrong.id}/authorization-url?redirectUri=${encodeURIComponent('https://app.example.test/callback')}`, admin)).body.data.state;
    expect((await c.post(`/api/v1/marketplace-accounts/${wrong.id}/authorize`, { code: 'garbage', state: wrongState, externalAccountId: seller }, admin)).status).toBe(401);
  });
});
