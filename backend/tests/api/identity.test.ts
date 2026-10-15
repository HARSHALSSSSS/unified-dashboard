import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, type TestApp } from '@oms/testing';

let t: TestApp;
const c = () => clientFor(t);
beforeAll(async () => { t = await buildTestApp({ database: true }); });
afterAll(() => t.close());

const REG = { businessName: 'Globex Traders', fullName: 'Gita Rao', email: 'gita@globex.test', password: 'a-long-enough-password' };

describe('registration', () => {
  it('creates the vendor and its admin, and sends exactly one verification mail', async () => {
    const before = t.mailer.sent.length;
    const r = await c().post('/api/v1/auth/register', REG);
    expect(r.status).toBe(201);
    expect(r.body.data.user.roles).toEqual(['vendor_admin']);
    expect(r.body.data.emailVerificationRequired).toBe(true);
    expect(t.mailer.sent.length).toBe(before + 1);
    expect(t.mailer.last('verify_email', REG.email)).toBeTruthy();
    // no tokens are returned by registration: the client logs in explicitly
    expect(JSON.stringify(r.body)).not.toMatch(/accessToken|refreshToken/);
  });

  it('rejects duplicates (case-insensitive e-mail), weak passwords and bad GSTIN', async () => {
    const dup = await c().post('/api/v1/auth/register', { ...REG, email: 'GITA@globex.test', businessName: 'Another' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.field).toBe('email');
    expect((await c().post('/api/v1/auth/register', { ...REG, email: 'x1@globex.test', password: 'short' })).status).toBe(400);
    const gst = await c().post('/api/v1/auth/register', { ...REG, email: 'x2@globex.test', gstin: '123' });
    expect(gst.status).toBe(400);
    expect(gst.body.error.details.issues[0].path).toBe('gstin');
  });

  it('gives two vendors with the same business name distinct slugs', async () => {
    const a = await c().post('/api/v1/auth/register', { ...REG, email: 's1@same.test', businessName: 'Same Name' });
    const b = await c().post('/api/v1/auth/register', { ...REG, email: 's2@same.test', businessName: 'Same Name' });
    expect(a.body.data.vendor.slug).toBe('same-name');
    expect(b.body.data.vendor.slug).not.toBe('same-name');
  });
});

describe('login', () => {
  it('returns a token pair, user and vendor; wrong password and unknown user look identical', async () => {
    const ok = await c().registerVendor();
    const bad = await c().post('/api/v1/auth/login', { email: ok.email, password: 'wrong-password-x' });
    const unknown = await c().post('/api/v1/auth/login', { email: 'nobody@nowhere.test', password: 'wrong-password-x' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error).toEqual(unknown.body.error);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after 5 failures and audits it', async () => {
    const a = await c().registerVendor();
    for (let i = 0; i < 5; i++) expect((await c().post('/api/v1/auth/login', { email: a.email, password: 'nope-nope-nope' })).status).toBe(401);
    const locked = await c().post('/api/v1/auth/login', { email: a.email, password: a.password });
    // while locked the answer is IDENTICAL to a wrong password: it must not reveal that the address has an account
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('INVALID_CREDENTIALS');
    const logs = await c().get('/api/v1/audit-logs?limit=50', a); // existing session still works
    expect(logs.body.data.map((l: any) => l.action)).toEqual(expect.arrayContaining(['auth.account_locked']));
  });

  it('parallel guesses cannot dodge the lock (the counter is atomic)', async () => {
    const a = await c().registerVendor();
    await Promise.all(Array.from({ length: 8 }, () => c().post('/api/v1/auth/login', { email: a.email, password: 'nope-nope-nope' })));
    expect((await c().post('/api/v1/auth/login', { email: a.email, password: a.password })).status).toBe(401); // locked despite the race
    const logs = await c().get('/api/v1/audit-logs?limit=50&filter[actionPrefix]=auth.', a);
    expect(logs.body.data.map((l: any) => l.action)).toContain('auth.account_locked');
  });

  it('is rate limited per IP+route', async () => {
    const limited = await buildTestApp({ database: true, config: { AUTH_RATE_LIMIT_MAX: '3' } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await clientFor(limited).post('/api/v1/auth/login', { email: 'a@b.test', password: 'whatever-123' })).status);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
    await limited.close();
  });
});

describe('tokens and sessions', () => {
  it('rotates refresh tokens and detects reuse (kills the whole session)', async () => {
    const a = await c().registerVendor();
    const r1 = await c().post('/api/v1/auth/refresh', { refreshToken: a.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.data.sessionId).toBe(a.sessionId); // same session, new tokens
    const fresh = r1.body.data;
    expect((await c().get('/api/v1/me', fresh.accessToken)).status).toBe(200);

    // replaying the OLD refresh token = theft signal
    const replay = await c().post('/api/v1/auth/refresh', { refreshToken: a.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_INVALID');
    // ...and the legitimate holder of the new token is logged out too
    expect((await c().post('/api/v1/auth/refresh', { refreshToken: fresh.refreshToken })).status).toBe(401);
    const after = await c().get('/api/v1/me', fresh.accessToken);
    expect(after.status).toBe(401);
  });

  it('logout ends the session immediately (access and refresh tokens)', async () => {
    const a = await c().registerVendor();
    expect((await c().get('/api/v1/me', a)).status).toBe(200);
    expect((await c().post('/api/v1/auth/logout', {}, a)).status).toBe(200);
    expect((await c().get('/api/v1/me', a)).status).toBe(401);
    expect((await c().post('/api/v1/auth/refresh', { refreshToken: a.refreshToken })).status).toBe(401);
  });

  it('lists sessions, marks the current one and revokes another', async () => {
    const a = await c().registerVendor();
    const second = await c().login(a.email, a.password);
    const list = await c().get('/api/v1/me/sessions', a);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.find((s: any) => s.current).id).toBe(a.sessionId);
    expect((await c().del(`/api/v1/me/sessions/${second.sessionId}`, a)).status).toBe(200);
    expect((await c().get('/api/v1/me', second)).status).toBe(401);
    expect((await c().get('/api/v1/me', a)).status).toBe(200);
    expect((await c().del(`/api/v1/me/sessions/${second.sessionId}`, a)).status).toBe(404);
  });

  it('logout-all signs out every device', async () => {
    const a = await c().registerVendor();
    const b = await c().login(a.email, a.password);
    const r = await c().post('/api/v1/auth/logout-all', {}, a);
    expect(r.body.data.revokedSessions).toBe(2);
    expect((await c().get('/api/v1/me', b)).status).toBe(401);
  });

  it('a user cannot revoke somebody else\'s session', async () => {
    const a = await c().registerVendor();
    const b = await c().registerVendor();
    expect((await c().del(`/api/v1/me/sessions/${b.sessionId}`, a)).status).toBe(404);
    expect((await c().get('/api/v1/me', b)).status).toBe(200);
  });
});

describe('e-mail verification', () => {
  it('tokens are single use; resend issues a new one', async () => {
    const a = await c().registerVendor({ verify: false });
    const first = t.mailer.last('verify_email', a.email)!.data.token;
    expect((await c().post('/api/v1/auth/resend-verification', {}, a)).status).toBe(202);
    const second = t.mailer.last('verify_email', a.email)!.data.token;
    expect(second).not.toBe(first);
    expect((await c().post('/api/v1/auth/verify-email', { token: first })).status).toBe(400); // superseded
    expect((await c().post('/api/v1/auth/verify-email', { token: second })).status).toBe(200);
    expect((await c().post('/api/v1/auth/verify-email', { token: second })).status).toBe(400); // used
    expect((await c().get('/api/v1/me/profile', a)).body.data.user.emailVerified).toBe(true);
  });
});

describe('password reset and change', () => {
  it('forgot-password never reveals whether an account exists', async () => {
    const a = await c().registerVendor();
    t.mailer.clear();
    const known = await c().post('/api/v1/auth/forgot-password', { email: a.email });
    const unknown = await c().post('/api/v1/auth/forgot-password', { email: 'ghost@nowhere.test' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body.data).toEqual(unknown.body.data);
    expect(t.mailer.sent.map((m) => m.to)).toEqual([a.email]);
  });

  it('reset works once, signs out every device, and the old password stops working', async () => {
    const a = await c().registerVendor();
    await c().post('/api/v1/auth/forgot-password', { email: a.email });
    const token = t.mailer.last('reset_password', a.email)!.data.token;
    expect((await c().post('/api/v1/auth/reset-password', { token, password: 'brand-new-password-1' })).status).toBe(200);
    expect((await c().post('/api/v1/auth/reset-password', { token, password: 'another-password-22' })).status).toBe(400);
    expect((await c().get('/api/v1/me', a)).status).toBe(401); // old session gone
    expect((await c().post('/api/v1/auth/login', { email: a.email, password: a.password })).status).toBe(401);
    expect((await c().post('/api/v1/auth/login', { email: a.email, password: 'brand-new-password-1' })).status).toBe(200);
  });

  it('rejects weak new passwords without consuming the token', async () => {
    const a = await c().registerVendor();
    await c().post('/api/v1/auth/forgot-password', { email: a.email });
    const token = t.mailer.last('reset_password', a.email)!.data.token;
    expect((await c().post('/api/v1/auth/reset-password', { token, password: 'short' })).status).toBe(400);
    expect((await c().post('/api/v1/auth/reset-password', { token, password: 'long-enough-password' })).status).toBe(200);
  });

  it('change-password needs the current password and keeps only the current session', async () => {
    const a = await c().registerVendor();
    const other = await c().login(a.email, a.password);
    expect((await c().post('/api/v1/me/change-password', { currentPassword: 'wrong-wrong-wrong', newPassword: 'new-password-12345' }, a)).status).toBe(401);
    expect((await c().post('/api/v1/me/change-password', { currentPassword: a.password, newPassword: 'new-password-12345' }, a)).status).toBe(200);
    expect((await c().get('/api/v1/me', a)).status).toBe(200);
    expect((await c().get('/api/v1/me', other)).status).toBe(401);
  });
});

describe('profile', () => {
  it('reads and updates my profile', async () => {
    const a = await c().registerVendor();
    const upd = await c().patch('/api/v1/me/profile', { fullName: 'Renamed Person' }, a);
    expect(upd.body.data.user.fullName).toBe('Renamed Person');
    expect((await c().patch('/api/v1/me/profile', { fullName: 'x' }, a)).status).toBe(400);
  });

  it('lists the assignable roles with their permissions', async () => {
    const a = await c().registerVendor();
    const roles = await c().get('/api/v1/roles', a);
    expect(roles.body.data.map((r: any) => r.key).sort()).toEqual(['vendor_admin', 'vendor_staff', 'vendor_viewer']);
    const staff = roles.body.data.find((r: any) => r.key === 'vendor_staff');
    expect(staff.permissions).toContain('products:write');
    expect(staff.permissions).not.toContain('users:write');
  });
});
