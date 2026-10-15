import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  generateRefreshToken, hashPassword, hashRefreshToken, hmacSha256Hex, parseKeyRing, PERMISSIONS, SecretBox, signAccessToken,
  SYSTEM_ROLES, verifyAccessToken, verifyHmacSignature, verifyPassword,
} from '@oms/auth';
import { AppError } from '@oms/shared';

const cfg = { issuer: 'oms', audience: 'oms-api', secret: 'x'.repeat(40), accessTtlSeconds: 900 };

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('garbage', 'x')).toBe(false);
  });
});

describe('access tokens', () => {
  const claims = { sub: 'u1', vid: 'v1', utp: 'vendor' as const, rol: ['vendor_admin'], sid: 's1' };
  it('round-trips claims', async () => {
    const { token } = await signAccessToken(cfg, claims);
    expect(await verifyAccessToken(cfg, token)).toEqual(claims);
  });
  it('rejects wrong secret, audience, expiry and alg=none', async () => {
    const { token } = await signAccessToken(cfg, claims);
    await expect(verifyAccessToken({ ...cfg, secret: 'y'.repeat(40) }, token)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await expect(verifyAccessToken({ ...cfg, audience: 'other' }, token)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    const expired = await new SignJWT({ vid: 'v1', utp: 'vendor', rol: [], sid: 's' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').setIssuer('oms').setAudience('oms-api').setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(new TextEncoder().encode(cfg.secret));
    await expect(verifyAccessToken(cfg, expired)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"u"}').toString('base64url')}.`;
    await expect(verifyAccessToken(cfg, none)).rejects.toBeInstanceOf(AppError);
  });
  it('refresh tokens are opaque and stored hashed', () => {
    const t = generateRefreshToken();
    expect(t.token.length).toBeGreaterThanOrEqual(43);
    expect(t.hash).toBe(hashRefreshToken(t.token));
    expect(t.hash).not.toContain(t.token);
  });
});

describe('SecretBox (AES-256-GCM envelope)', () => {
  const ring = parseKeyRing(`k2:${Buffer.alloc(32, 2).toString('base64')},k1:${Buffer.alloc(32, 1).toString('base64')}`);
  const box = new SecretBox(ring);
  it('encrypts and decrypts, non-deterministically', () => {
    const a = box.encrypt('refresh-token', 'aad');
    expect(box.decrypt(a, 'aad')).toBe('refresh-token');
    expect(a).not.toContain('refresh-token');
    expect(box.encrypt('refresh-token', 'aad')).not.toBe(a);
  });
  it('binds ciphertext to its context (AAD) and detects tampering', () => {
    const a = box.encrypt('secret', 'marketplace_authorizations:vendorA');
    expect(() => box.decrypt(a, 'marketplace_authorizations:vendorB')).toThrow();
    const parts = a.split('.'); parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'marketplace_authorizations:vendorA')).toThrow();
  });
  it('supports key rotation', () => {
    const old = new SecretBox(parseKeyRing(`k1:${Buffer.alloc(32, 1).toString('base64')}`)).encrypt('v', 'a');
    expect(box.decrypt(old, 'a')).toBe('v');
    expect(box.needsRotation(old)).toBe(true);
    expect(box.needsRotation(box.encrypt('v', 'a'))).toBe(false);
  });
  it('rejects bad key material', () => {
    expect(() => parseKeyRing('k:short')).toThrow();
    expect(() => parseKeyRing('')).toThrow();
  });
});

describe('webhook signatures', () => {
  const secret = 's3cret';
  const body = Buffer.from('{"a":1}');
  it('accepts a valid signature and rejects tampering', () => {
    const sig = hmacSha256Hex(secret, body);
    expect(verifyHmacSignature({ secret, rawBody: body, signature: `sha256=${sig}` })).toBe(true);
    expect(verifyHmacSignature({ secret, rawBody: Buffer.from('{"a":2}'), signature: sig })).toBe(false);
    expect(verifyHmacSignature({ secret, rawBody: body, signature: 'short' })).toBe(false);
  });
  it('rejects stale timestamps (replay)', () => {
    const ts = 1_700_000_000;
    const sig = hmacSha256Hex(secret, `${ts}.${body.toString()}`);
    const now = new Date((ts + 10) * 1000);
    expect(verifyHmacSignature({ secret, rawBody: body, signature: sig, timestamp: ts, now })).toBe(true);
    expect(verifyHmacSignature({ secret, rawBody: body, signature: sig, timestamp: ts, now: new Date((ts + 3600) * 1000) })).toBe(false);
  });
});

describe('rbac catalogue', () => {
  it('system roles only reference known permissions', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const [k, r] of Object.entries(SYSTEM_ROLES)) for (const p of r.permissions) expect(known.has(p), `${k}:${p}`).toBe(true);
  });
  it('vendor roles never include platform permissions', () => {
    for (const r of Object.values(SYSTEM_ROLES).filter((x) => x.userType === 'vendor')) {
      expect(r.permissions.some((p) => p.startsWith('platform:'))).toBe(false);
    }
  });
  it('viewer is read-only', () => {
    expect(SYSTEM_ROLES.vendor_viewer!.permissions.every((p) => p.endsWith(':read'))).toBe(true);
  });
});
