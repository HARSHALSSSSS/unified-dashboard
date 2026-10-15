import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { withVendor, writeAudit, writeOutboxEvent } from '@oms/database';
import { AppError, newId } from '@oms/shared';
import {
  CircuitBreaker, ConnectorError, TimeoutError, withRetry, withTimeout, type ConnectorContext, type ConnectorCredentials, type CredentialSet, type MarketplaceConnector, type RetryOptions,
} from '@oms/marketplace-core';
import type { Container } from '@oms/module-kit';
import {
  clearAuthorization, getAccountRow, getAuthorizationRow, loadCredentials, markAuthorizationExpiring, recordFailure, recordSuccess, saveAuthorization, type AccountRow,
} from '@oms/mod-marketplace-accounts';

/** Refresh when the access token has less than this left. */
const REFRESH_AHEAD_MS = 2 * 60_000;

// ------------------------------------------------------------------------------------------------
// OAuth `state`: signed, short-lived, bound to (vendor, account) -> CSRF protection for the redirect flow
// ------------------------------------------------------------------------------------------------
export function signState(secret: string, vendorId: string, accountId: string, ttlMs = 10 * 60_000, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ v: vendorId, a: accountId, e: now + ttlMs, n: newId() })).toString('base64url');
  return `${payload}.${createHmac('sha256', `oauth-state:${secret}`).update(payload).digest('base64url')}`;
}

export function verifyState(secret: string, state: string, vendorId: string, accountId: string, now = Date.now()): boolean {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', `oauth-state:${secret}`).update(payload).digest('base64url');
  if (!timingSafeEqual(createHash('sha256').update(sig).digest(), createHash('sha256').update(expected).digest())) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { v: string; a: string; e: number };
    return p.v === vendorId && p.a === accountId && p.e > now;
  } catch { return false; }
}

// ------------------------------------------------------------------------------------------------
// per-account rate limiting (in-process token bucket; a Redis-backed limiter replaces it when workers scale out)
// ------------------------------------------------------------------------------------------------
class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Waits (up to maxWaitMs) for a token; throws RATE_LIMITED if the account is saturated. */
  async acquire(key: string, rps: number, burst: number, maxWaitMs = 2_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const now = Date.now();
      const b = this.buckets.get(key) ?? { tokens: burst, at: now };
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rps);
      b.at = now;
      if (b.tokens >= 1) { b.tokens -= 1; this.buckets.set(key, b); return; }
      this.buckets.set(key, b);
      const wait = Math.ceil(((1 - b.tokens) / rps) * 1000);
      if (Date.now() + wait > deadline) throw new AppError('RATE_LIMITED', 'Marketplace rate limit reached for this account; retry shortly', { details: { retryAfterSeconds: Math.ceil(wait / 1000) } });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export interface HostOptions { retry?: RetryOptions; now?: () => Date }

/** Retry policy from configuration (CONNECTOR_RETRY_*), overridable per host instance. */
const retryFrom = (c: Container, o: HostOptions): RetryOptions => ({
  attempts: c.config.CONNECTOR_RETRY_ATTEMPTS, baseDelayMs: c.config.CONNECTOR_RETRY_BASE_MS, maxDelayMs: c.config.CONNECTOR_RETRY_MAX_MS, retryAfterCapMs: c.config.CONNECTOR_RETRY_AFTER_CAP_MS, ...o.retry,
});

/**
 * Runtime host for connectors. It is the ONLY code that decrypts marketplace credentials, and it:
 *   - checks the account is connected and the connector is usable (not `planned`)
 *   - refreshes tokens ahead of expiry, and once on an `auth` failure, persisting the rotation (re-encrypted)
 *   - applies per-account rate limiting and bounded retries (backoff + Retry-After) for transient/429 errors
 *   - records connection health (last success / last failure / authorization state)
 *   - translates ConnectorError into API errors without leaking upstream internals
 * Database transactions are SHORT and never span a network call to a marketplace.
 */
/**
 * Process-wide (a ConnectorHost is created per job, so instance fields would give every job a fresh rate-limit bucket and a fresh
 * circuit): all calls to one marketplace account in this process share one limiter and one breaker.
 */
const SHARED_LIMITER = new TokenBuckets();
let sharedBreaker: CircuitBreaker | null = null;

export class ConnectorHost {
  private readonly limiter = SHARED_LIMITER;
  private readonly breaker: CircuitBreaker;
  constructor(private readonly c: Container, private readonly opts: HostOptions = {}) {
    sharedBreaker ??= new CircuitBreaker(c.config.CONNECTOR_BREAKER_THRESHOLD, c.config.CONNECTOR_BREAKER_OPEN_MS);
    this.breaker = sharedBreaker;
  }

  private get now(): Date { return this.opts.now?.() ?? new Date(); }
  private db() { return this.c.database.db; }

  connectorFor(account: Pick<AccountRow, 'marketplace' | 'mode'>): MarketplaceConnector {
    const connector = this.c.connectors.get(account.marketplace);
    if (connector.implementation === 'planned') {
      throw new AppError('CAPABILITY_UNSUPPORTED', `${connector.displayName} integration is not available yet`, { details: { marketplace: connector.code, implementation: 'planned' } });
    }
    // never fake production access: a connector is only usable against a LIVE marketplace once it declares readiness.live
    if (account.mode === 'live' && !connector.readiness.live) {
      throw new AppError('CAPABILITY_UNSUPPORTED', `${connector.displayName} is not verified for live use yet; connect a sandbox account`, { details: { marketplace: connector.code, reason: 'live_not_verified', notes: connector.readiness.notes } });
    }
    return connector;
  }

  private context(account: AccountRow, credentials: ConnectorCredentials, requestId?: string): ConnectorContext {
    return { vendorId: account.vendorId, marketplaceAccountId: account.id, externalAccountId: account.externalAccountId, mode: account.mode as 'live' | 'sandbox', config: account.config as Record<string, unknown>, credentials, requestId };
  }

  /** Run `fn` against a connected account with full lifecycle handling. */
  async run<T>(vendorId: string, accountId: string, fn: (connector: MarketplaceConnector, ctx: ConnectorContext) => Promise<T>, opts: { requestId?: string } = {}): Promise<T> {
    const loaded = await withVendor(this.db(), vendorId, async (tx) => {
      const account = await getAccountRow(tx, vendorId, accountId);
      const creds = account.status === 'active' ? await loadCredentials(tx, this.c, vendorId, accountId) : null;
      return { account, creds };
    });
    const { account } = loaded;
    if (account.status !== 'active' || !loaded.creds) {
      throw new AppError('ACCOUNT_NOT_CONNECTED', account.status === 'paused' ? 'Marketplace account is paused' : undefined, { details: { status: account.status } });
    }
    const connector = this.connectorFor(account);
    const { limits } = connector.capabilities;
    let credentials = loaded.creds.credentials;
    const expiresAt = loaded.creds.authorization.accessTokenExpiresAt;

    // proactive refresh
    if (expiresAt && expiresAt.getTime() - this.now.getTime() < REFRESH_AHEAD_MS && connector.refreshCredentials) {
      const next = await this.refreshInternal(account, connector, credentials);
      credentials = next.credentials;
    }

    // an account whose marketplace keeps failing is not called for a while (fail fast instead of piling up retries)
    const wait = this.breaker.check(account.id);
    if (wait !== null) throw new AppError('UPSTREAM_ERROR', 'The marketplace is temporarily unavailable; calls are paused briefly', { details: { kind: 'transient', code: 'circuit_open', retryAfterSeconds: Math.ceil(wait / 1000), marketplace: account.marketplace } });

    let refreshedOnAuthError = false;
    try {
      const result = await withRetry(async () => {
        await this.limiter.acquire(account.id, limits.requestsPerSecond, limits.burst);
        try {
          return await withTimeout(() => fn(connector, this.context(account, credentials, opts.requestId)), this.c.config.CONNECTOR_TIMEOUT_MS);
        } catch (e) {
          // expired/invalid access token: refresh ONCE and retry the call
          if (e instanceof ConnectorError && e.kind === 'auth' && connector.refreshCredentials && !refreshedOnAuthError) {
            refreshedOnAuthError = true;
            const next = await this.refreshInternal(account, connector, credentials);
            credentials = next.credentials;
            return fn(connector, this.context(account, credentials, opts.requestId));
          }
          throw e;
        }
      }, retryFrom(this.c, this.opts));
      this.breaker.success(account.id);
      await withVendor(this.db(), vendorId, (tx) => recordSuccess(tx, vendorId, accountId));
      return result;
    } catch (e) {
      // only outages count towards the breaker: bad credentials / bad input are not an outage
      if (e instanceof TimeoutError || (e instanceof ConnectorError && (e.kind === 'transient' || e.kind === 'rate_limited'))) this.breaker.failure(account.id);
      if (e instanceof TimeoutError) throw await this.handleFailure(vendorId, accountId, connector, new ConnectorError('transient', e.message, { code: 'timeout' }));
      throw await this.handleFailure(vendorId, accountId, connector, e);
    }
  }

  /** Force a token refresh (operator action / scheduled job). */
  async refresh(vendorId: string, accountId: string): Promise<AccountRow> {
    const loaded = await withVendor(this.db(), vendorId, async (tx) => ({ account: await getAccountRow(tx, vendorId, accountId), creds: await loadCredentials(tx, this.c, vendorId, accountId) }));
    if (!loaded.creds) throw new AppError('ACCOUNT_NOT_CONNECTED');
    const connector = this.connectorFor(loaded.account);
    if (!connector.refreshCredentials) throw new AppError('CAPABILITY_UNSUPPORTED', `${connector.displayName} tokens are not refreshable`, { details: { capability: 'auth.refreshable' } });
    try {
      await this.refreshInternal(loaded.account, connector, loaded.creds.credentials);
    } catch (e) {
      throw await this.handleFailure(vendorId, accountId, connector, e);
    }
    return withVendor(this.db(), vendorId, (tx) => getAccountRow(tx, vendorId, accountId));
  }

  private async refreshInternal(account: AccountRow, connector: MarketplaceConnector, credentials: ConnectorCredentials): Promise<CredentialSet> {
    const refresher = connector.refreshCredentials!;
    const next = await withRetry(() => refresher.call(connector, this.context(account, credentials)), retryFrom(this.c, this.opts));
    await withVendor(this.db(), account.vendorId, async (tx) => {
      await saveAuthorization(tx, this.c, {
        vendorId: account.vendorId, accountId: account.id, authType: connector.capabilities.auth.type, credentials: next.credentials,
        scopes: next.scopes, expiresAt: next.expiresAt ?? null, rotation: true,
      });
      await writeAudit(tx, { vendorId: account.vendorId, actorType: 'system', actorId: 'connector-host', action: 'marketplace_account.tokens_rotated', resourceType: 'marketplace_account', resourceId: account.id });
    });
    return next;
  }

  /** Translate + record a failure. Auth failures expire the authorization and require a reconnect. */
  private async handleFailure(vendorId: string, accountId: string, connector: MarketplaceConnector, e: unknown): Promise<unknown> {
    if (e instanceof AppError) return e; // already a platform error (rate limit, not connected...)
    if (!(e instanceof ConnectorError)) return e;
    const authFailed = e.kind === 'auth';
    await withVendor(this.db(), vendorId, async (tx) => {
      await recordFailure(tx, vendorId, accountId, { message: e.message, code: e.code, authFailed });
      if (authFailed) {
        await writeOutboxEvent(tx, { type: 'marketplace_account.authorization_expired', vendorId, aggregateType: 'marketplace_account', aggregateId: accountId, payload: { marketplace: connector.code, code: e.code } });
        await writeAudit(tx, { vendorId, actorType: 'system', actorId: 'connector-host', action: 'marketplace_account.authorization_failed', resourceType: 'marketplace_account', resourceId: accountId, metadata: { code: e.code } });
      }
    });
    this.c.logger.warn({ marketplace: connector.code, accountId, kind: e.kind, code: e.code }, 'connector call failed');
    return new AppError(e.kind === 'rate_limited' ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', authFailed ? 'The marketplace rejected the stored credentials; reconnect the account' : e.message, {
      details: { marketplace: connector.code, kind: e.kind, code: e.code, ...(authFailed ? { action: 'reconnect' } : {}), ...(e.opts.retryAfterMs ? { retryAfterSeconds: Math.ceil(e.opts.retryAfterMs / 1000) } : {}) },
      cause: e,
    });
  }

  // ------------------------------------------------------------------ authorization lifecycle
  /** Connect (or reconnect) an account from an authorization code (redirect flow) or direct credentials. */
  async authorize(vendorId: string, accountId: string, input: { code?: string; redirectUri?: string; externalAccountId?: string; credentials?: ConnectorCredentials }) {
    const account = await withVendor(this.db(), vendorId, (tx) => getAccountRow(tx, vendorId, accountId));
    const connector = this.connectorFor(account);

    let result: CredentialSet & { externalAccountId: string };
    try {
      if (input.code !== undefined) {
        if (!connector.exchangeAuthorizationCode) throw new AppError('CAPABILITY_UNSUPPORTED', `${connector.displayName} has no redirect authorization flow`, { details: { capability: 'auth.redirectFlow' } });
        result = await withRetry(() => connector.exchangeAuthorizationCode!({ code: input.code!, redirectUri: input.redirectUri, externalAccountId: input.externalAccountId, mode: account.mode as 'live' | 'sandbox', config: account.config as Record<string, unknown> }), retryFrom(this.c, this.opts));
      } else {
        if (!connector.authenticate) throw new AppError('CAPABILITY_UNSUPPORTED', `${connector.displayName} does not accept direct credentials`, { details: { capability: 'auth.credentials' } });
        result = await withRetry(() => connector.authenticate!({ credentials: input.credentials ?? {}, mode: account.mode as 'live' | 'sandbox', config: account.config as Record<string, unknown> }), retryFrom(this.c, this.opts));
      }
      // prove the credentials work before storing them
      const probe = await connector.verifyConnection({ ...this.context({ ...account, externalAccountId: result.externalAccountId }, result.credentials) });
      if (!probe.ok) throw new ConnectorError('auth', probe.message ?? 'Connection check failed');
    } catch (e) {
      if (e instanceof ConnectorError) {
        await withVendor(this.db(), vendorId, (tx) => recordFailure(tx, vendorId, accountId, { message: e.message, code: e.code, authFailed: false }));
        throw new AppError(e.kind === 'auth' ? 'INVALID_CREDENTIALS' : 'UPSTREAM_ERROR', e.kind === 'auth' ? 'The marketplace rejected the authorization' : e.message, { details: { marketplace: connector.code, kind: e.kind, code: e.code } });
      }
      throw e;
    }

    const wasConnected = account.status === 'active';
    await withVendor(this.db(), vendorId, async (tx) => {
      await saveAuthorization(tx, this.c, {
        vendorId, accountId, authType: connector.capabilities.auth.type, credentials: result.credentials, scopes: result.scopes, expiresAt: result.expiresAt ?? null,
        externalAccountId: result.externalAccountId, rotation: wasConnected,
      });
      await writeOutboxEvent(tx, { type: 'marketplace_account.connected', vendorId, aggregateType: 'marketplace_account', aggregateId: accountId, payload: { marketplace: connector.code, mode: account.mode } });
    });
    return withVendor(this.db(), vendorId, (tx) => getAccountRow(tx, vendorId, accountId));
  }

  async disconnect(vendorId: string, accountId: string): Promise<void> {
    await withVendor(this.db(), vendorId, async (tx) => {
      const account = await getAccountRow(tx, vendorId, accountId);
      if (account.status === 'pending_authorization') throw new AppError('CONFLICT', 'Account was never connected');
      await clearAuthorization(tx, vendorId, accountId);
      await writeOutboxEvent(tx, { type: 'marketplace_account.disconnected', vendorId, aggregateType: 'marketplace_account', aggregateId: accountId, payload: { marketplace: account.marketplace } });
    });
  }

  /** Connection health probe; never throws for marketplace-side problems, reports them. */
  async healthCheck(vendorId: string, accountId: string) {
    const checkedAt = this.now.toISOString();
    try {
      const out = await this.run(vendorId, accountId, (connector, ctx) => connector.verifyConnection(ctx));
      const account = await withVendor(this.db(), vendorId, async (tx) => ({ a: await getAccountRow(tx, vendorId, accountId), z: await loadAuthMeta(tx, vendorId, accountId) }));
      return { ok: out.ok, connectionStatus: account.a.connectionStatus, message: out.message ?? null, checkedAt, tokenExpiresAt: account.z };
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      if (e.code === 'NOT_FOUND') throw e;
      const account = await withVendor(this.db(), vendorId, (tx) => getAccountRow(tx, vendorId, accountId));
      return { ok: false, connectionStatus: account.connectionStatus, message: e.message, checkedAt, tokenExpiresAt: null as string | null };
    }
  }

  /** Mark tokens as "expiring" (used by the scheduled token-maintenance job). */
  async flagExpiring(vendorId: string, accountId: string): Promise<void> {
    await withVendor(this.db(), vendorId, (tx) => markAuthorizationExpiring(tx, vendorId, accountId));
  }
}

async function loadAuthMeta(tx: Parameters<typeof getAccountRow>[0], vendorId: string, accountId: string): Promise<string | null> {
  const z = await getAuthorizationRow(tx, vendorId, accountId);
  return z?.accessTokenExpiresAt ? z.accessTokenExpiresAt.toISOString() : null;
}
