import { describe, expect, it } from 'vitest';
import { parseConfig } from '@oms/config';
import { TEST_ENV } from '@oms/testing';

/** a configuration that passes the production readiness checks */
const PROD_ENV: Record<string, string | undefined> = {
  ...TEST_ENV, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'Zk3v9qLw1XrT7mNc4HbY8dFs2PjA6eUo0GiKt5RxVnWyQz1B', ENCRYPTION_KEYS: 'k2025:' + Buffer.alloc(32, 7).toString('base64'),
  METRICS_TOKEN: 'metrics-token-0123456789', CORS_ORIGINS: 'https://app.example.com', DATABASE_URL: 'postgres://oms_app:pw@db.example.com:5432/oms', DATABASE_SSL: 'true', STORAGE_DRIVER: 's3',
  TRUST_PROXY: '1', APP_WEB_URL: 'https://app.example.com', PUBLIC_BASE_URL: 'https://api.example.com', PUBLIC_API_URL: 'https://api.example.com', AUTH_RATE_LIMIT_MAX: '10', EMAIL_VERIFICATION_REQUIRED: 'true',
};

describe('config', () => {
  it('parses a valid environment with sane defaults', () => {
    const c = parseConfig(TEST_ENV);
    expect(c.PORT).toBe(3000);
    expect(c.isTest).toBe(true);
    expect(c.CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });
  it('fails fast and names every problem', () => {
    expect(() => parseConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL[\s\S]*JWT_ACCESS_SECRET[\s\S]*ENCRYPTION_KEYS/);
  });
  it('rejects weak JWT secrets', () => {
    expect(() => parseConfig({ ...TEST_ENV, JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 32/);
  });
  it('disables swagger by default in production, enables elsewhere', () => {
    const { SWAGGER_ENABLED: _omit, ...rest } = PROD_ENV;
    expect(parseConfig({ ...rest, NODE_ENV: 'production' }).swaggerEnabled).toBe(false);
    expect(parseConfig({ ...rest, NODE_ENV: 'staging' }).swaggerEnabled).toBe(true);
    expect(parseConfig({ ...rest, NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }).swaggerEnabled).toBe(true);
    expect(parseConfig({ ...rest, NODE_ENV: 'production' })).toMatchObject({ mockMarketplaceEnabled: false, sandboxCourierEnabled: false });
    expect(parseConfig({ ...TEST_ENV }).sandboxCourierEnabled).toBe(true);
  });
  it('production refuses a valid-but-unsafe configuration and lists every problem', () => {
    expect(() => parseConfig({ ...TEST_ENV, NODE_ENV: 'production' })).toThrow(/Unsafe production configuration[\s\S]*JWT_ACCESS_SECRET[\s\S]*METRICS_TOKEN[\s\S]*CORS_ORIGINS[\s\S]*DATABASE_SSL/);
    for (const [patch, msg] of [
      [{ JWT_ACCESS_SECRET: 'x'.repeat(40) }, /JWT_ACCESS_SECRET/], [{ METRICS_TOKEN: undefined }, /METRICS_TOKEN/], [{ CORS_ORIGINS: '*' }, /CORS_ORIGINS/], [{ CORS_ORIGINS: 'http://app.example.com' }, /https origins/],
      [{ DATABASE_SSL: 'false' }, /DATABASE_SSL/], [{ DATABASE_URL: 'postgres://oms_owner:p@db.example.com/oms' }, /restricted application role/], [{ DATABASE_URL: 'postgres://postgres:p@db.example.com/oms' }, /restricted application role/],
      [{ STORAGE_DRIVER: 'memory' }, /STORAGE_DRIVER/], [{ TRUST_PROXY: 'false' }, /TRUST_PROXY/], [{ TRUST_PROXY: 'true' }, /spoof/], [{ EMAIL_VERIFICATION_REQUIRED: 'false' }, /EMAIL_VERIFICATION_REQUIRED/],
      [{ AUTH_RATE_LIMIT_MAX: '500' }, /AUTH_RATE_LIMIT_MAX/], [{ APP_WEB_URL: 'http://app.example.com' }, /APP_WEB_URL/], [{ ENCRYPTION_KEYS: 'dev1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' }, /development key/],
    ] as Array<[Record<string, string | undefined>, RegExp]>) {
      expect(() => parseConfig({ ...PROD_ENV, ...patch }), JSON.stringify(patch)).toThrow(msg);
    }
    expect(parseConfig(PROD_ENV).isProd).toBe(true);
    // staging is held to the same standard (except TRUST_PROXY)
    expect(() => parseConfig({ ...PROD_ENV, NODE_ENV: 'staging', METRICS_TOKEN: undefined })).toThrow(/METRICS_TOKEN/);
  });
  it('splits CORS origins', () => {
    expect(parseConfig({ ...TEST_ENV, CORS_ORIGINS: 'https://a.com, https://b.com' }).CORS_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
  });
});
