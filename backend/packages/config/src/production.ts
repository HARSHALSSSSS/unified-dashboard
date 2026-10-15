import type { Env } from './env';

const DEV_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const WEAK = /change-?me|dev-?only|example|secret|password|test/i;

/**
 * Production / staging refuse to start with a configuration that is merely *valid* but unsafe: development secrets, an open CORS
 * list, plain-http URLs, an unauthenticated metrics endpoint, a database role that bypasses row-level security, in-memory
 * storage... Every problem is listed at once. (Development and test keep their convenient defaults.)
 * `strict` (production) additionally requires TRUST_PROXY.
 */
export function assertProductionReadiness(env: Env, strict: boolean): void {
  const problems: string[] = [];
  if (env.JWT_ACCESS_SECRET.length < 48 || WEAK.test(env.JWT_ACCESS_SECRET)) problems.push('JWT_ACCESS_SECRET must be a random value of at least 48 characters (not a development placeholder)');
  for (const k of env.ENCRYPTION_KEYS.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [id, b64] = k.split(':');
    if (!id || !b64 || Buffer.from(b64, 'base64').length !== 32) problems.push('ENCRYPTION_KEYS entries must be keyId:base64(32 random bytes)');
    else if (/^dev/i.test(id) || b64 === DEV_KEY) problems.push('ENCRYPTION_KEYS contains the development key');
  }
  if (env.METRICS_ENABLED && (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 16)) problems.push('METRICS_TOKEN (16+ characters) is required while METRICS_ENABLED=true');
  for (const o of env.CORS_ORIGINS) {
    if (o === '*' || /localhost|127\.0\.0\.1/.test(o) || !o.startsWith('https://')) problems.push(`CORS_ORIGINS must be explicit https origins (found "${o}")`);
  }
  for (const [name, url] of [['APP_WEB_URL', env.APP_WEB_URL], ['PUBLIC_BASE_URL', env.PUBLIC_BASE_URL], ['PUBLIC_API_URL', env.PUBLIC_API_URL]] as const) {
    if (!url.startsWith('https://')) problems.push(`${name} must be an https URL`);
  }
  if (!env.DATABASE_SSL) problems.push('DATABASE_SSL must be true');
  const dbUser = (() => { try { return decodeURIComponent(new URL(env.DATABASE_URL).username); } catch { return ''; } })();
  if (/^(postgres|root|admin)$|owner/i.test(dbUser)) problems.push('DATABASE_URL must use the restricted application role (an owner / superuser bypasses row-level security)');
  if (env.STORAGE_DRIVER === 'memory') problems.push('STORAGE_DRIVER=memory is not allowed (data would be lost on restart)');
  if (!env.EMAIL_VERIFICATION_REQUIRED) problems.push('EMAIL_VERIFICATION_REQUIRED must stay true');
  if (env.AUTH_RATE_LIMIT_MAX > 20) problems.push('AUTH_RATE_LIMIT_MAX must be 20 or less');
  if (env.TRUST_PROXY === true) problems.push('TRUST_PROXY=true believes every X-Forwarded-For hop (clients can spoof their IP and dodge rate limits): use the number of proxy hops (e.g. 1) or the proxy CIDRs');
  if (strict && env.TRUST_PROXY === false) problems.push('TRUST_PROXY must be set to the number of proxy hops (e.g. 1) or the load balancer CIDRs (otherwise every client shares one rate-limit bucket and audit logs record the proxy IP)');
  if (problems.length) throw new Error(`Unsafe production configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}
