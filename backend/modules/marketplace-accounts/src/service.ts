import { and, eq, escapeLike, ilike, isFeatureEnabled, keyset, or, schema, sql, type SQL, type Tx } from '@oms/database';
import { getSecretBox } from '@oms/auth';
import { AppError, Errors } from '@oms/shared';
import type { ConnectorCredentials } from '@oms/marketplace-core';
import { enforceLimit } from '@oms/mod-billing';
import type { Container } from '@oms/module-kit';

export type AccountRow = typeof schema.marketplaceAccounts.$inferSelect;
export type AuthorizationRow = typeof schema.marketplaceAuthorizations.$inferSelect;

const A = schema.marketplaceAccounts;
const Z = schema.marketplaceAuthorizations;

/**
 * API shape of an account. SAFE BY CONSTRUCTION: it is built from an explicit allow-list of columns; the
 * ciphertext, key id and any credential are never mapped, so they cannot leak through a serializer change.
 */
export function toAccountDto(a: AccountRow, z: AuthorizationRow | null) {
  return {
    id: a.id,
    marketplace: a.marketplace,
    displayName: a.displayName,
    externalAccountId: a.externalAccountId,
    region: a.region,
    mode: a.mode as 'live' | 'sandbox',
    status: a.status as 'pending_authorization' | 'active' | 'paused' | 'error' | 'revoked',
    connectionStatus: a.connectionStatus as 'unknown' | 'connected' | 'degraded' | 'disconnected' | 'error',
    authorization: z
      ? {
          status: z.status as 'active' | 'expiring' | 'expired' | 'revoked' | 'error',
          authType: z.authType,
          scopes: z.scopes,
          accessTokenExpiresAt: z.accessTokenExpiresAt ? z.accessTokenExpiresAt.toISOString() : null,
          lastRefreshedAt: z.lastRefreshedAt ? z.lastRefreshedAt.toISOString() : null,
          rotationCount: z.rotationCount,
          lastErrorCode: z.lastErrorCode,
          lastErrorAt: z.lastErrorAt ? z.lastErrorAt.toISOString() : null,
        }
      : null,
    config: a.config as Record<string, unknown>,
    lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
    lastSuccessAt: a.lastSuccessAt ? a.lastSuccessAt.toISOString() : null,
    lastFailureAt: a.lastFailureAt ? a.lastFailureAt.toISOString() : null,
    lastFailureMessage: a.lastFailureMessage,
    version: a.version,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function getAccountRow(tx: Tx, vendorId: string, id: string): Promise<AccountRow> {
  const [a] = await tx.select().from(A).where(and(eq(A.id, id), eq(A.vendorId, vendorId)));
  if (!a) throw Errors.notFound('Marketplace account', id);
  return a;
}

export async function getAuthorizationRow(tx: Tx, vendorId: string, accountId: string): Promise<AuthorizationRow | null> {
  const [z] = await tx.select().from(Z).where(and(eq(Z.vendorId, vendorId), eq(Z.marketplaceAccountId, accountId)));
  return z ?? null;
}

export async function getAccount(tx: Tx, vendorId: string, id: string) {
  const a = await getAccountRow(tx, vendorId, id);
  return toAccountDto(a, await getAuthorizationRow(tx, vendorId, id));
}

export interface CreateAccountInput { marketplace: string; displayName: string; externalAccountId?: string | null; region?: string; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }

export async function createAccount(tx: Tx, c: Container, vendorId: string, input: CreateAccountInput) {
  const connector = c.connectors.get(input.marketplace); // 404 for unknown / disabled marketplaces (e.g. mock in production)
  // the platform can switch a connector off (globally or for one vendor) and plans can limit the number of connections
  if (!(await isFeatureEnabled(tx, `connector.${connector.code}.enabled`, vendorId, true))) throw new AppError('FORBIDDEN', `${connector.displayName} connections are not available right now`, { details: { rule: 'feature_disabled', flag: `connector.${connector.code}.enabled` } });
  await enforceLimit(tx, vendorId, 'marketplace_accounts');
  const mode = connector.code === 'mock' ? 'sandbox' : input.mode ?? 'live';
  if (connector.code === 'mock' && input.mode === 'live') throw Errors.validation({ issues: [{ path: 'mode', message: 'the mock marketplace is sandbox-only' }] });
  const [row] = await tx
    .insert(A)
    .values({ vendorId, marketplace: connector.code, displayName: input.displayName, externalAccountId: input.externalAccountId ?? null, region: input.region ?? 'IN', mode, config: input.config ?? {}, status: 'pending_authorization', connectionStatus: 'unknown' })
    .returning();
  return toAccountDto(row!, null);
}

export interface AccountListInput { limit: number; cursor?: string; q?: string; marketplace?: string; status?: string; sort?: Array<{ field: string; direction: 'asc' | 'desc' }> }

export async function listAccounts(tx: Tx, vendorId: string, input: AccountListInput) {
  const ks = keyset<{ a: AccountRow; z: AuthorizationRow | null }>({
    sorts: { createdAt: { column: A.createdAt, kind: 'timestamp' }, displayName: { column: A.displayName, kind: 'text' } },
    idColumn: A.id,
    sort: input.sort,
    defaultSort: { field: 'createdAt', direction: 'desc' },
    cursor: input.cursor,
    limit: input.limit,
  });
  const search: SQL | undefined = input.q ? or(ilike(A.displayName, `%${escapeLike(input.q)}%`), ilike(A.externalAccountId, `%${escapeLike(input.q)}%`)) : undefined;
  const field = input.sort?.[0]?.field ?? 'createdAt';
  const rows = await tx
    .select({ a: A, z: Z })
    .from(A)
    .leftJoin(Z, and(eq(Z.marketplaceAccountId, A.id), eq(Z.vendorId, A.vendorId)))
    .where(and(eq(A.vendorId, vendorId), input.marketplace ? eq(A.marketplace, input.marketplace) : undefined, input.status ? eq(A.status, input.status) : undefined, search, ks.where))
    .orderBy(...ks.orderBy)
    .limit(ks.fetch);
  const page = ks.finish(rows, ({ a }) => ({ sortValue: field === 'displayName' ? a.displayName : a.createdAt, id: a.id }));
  return { items: page.items.map(({ a, z }) => toAccountDto(a, z)), nextCursor: page.nextCursor };
}

export async function updateAccount(tx: Tx, vendorId: string, id: string, patch: { displayName?: string; config?: Record<string, unknown>; status?: 'active' | 'paused'; version?: number }) {
  const before = await getAccountRow(tx, vendorId, id);
  if (patch.version !== undefined && patch.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });
  if (patch.status) {
    if (before.status !== 'active' && before.status !== 'paused') throw new AppError('CONFLICT', 'Only a connected account can be paused or resumed', { details: { rule: 'not_connected' } });
  }
  const [after] = await tx
    .update(A)
    .set({ displayName: patch.displayName ?? before.displayName, config: patch.config ?? before.config, status: patch.status ?? before.status, version: sql`${A.version} + 1` })
    .where(eq(A.id, id))
    .returning();
  return { before, after: after! };
}

export async function deleteAccount(tx: Tx, vendorId: string, id: string) {
  const a = await getAccountRow(tx, vendorId, id);
  if (a.status === 'active') throw new AppError('CONFLICT', 'Disconnect the account before deleting it', { details: { rule: 'still_connected' } });
  await tx.delete(A).where(eq(A.id, id)); // authorization row cascades
  return a;
}

// ------------------------------------------------------------------------------------------------
// credential custody
// ------------------------------------------------------------------------------------------------
const aad = (vendorId: string, accountId: string) => `marketplace_authorizations:${vendorId}:${accountId}`;

export interface SaveAuthorizationInput {
  vendorId: string; accountId: string; authType: string; credentials: ConnectorCredentials; scopes?: string[]; expiresAt?: Date | null;
  externalAccountId?: string | null; /** true when replacing tokens of an existing authorization (counts as a rotation) */ rotation?: boolean;
}

/** Encrypts and stores credentials (AES-256-GCM, AAD-bound to vendor+account) and marks the account connected. */
export async function saveAuthorization(tx: Tx, c: Container, input: SaveAuthorizationInput): Promise<void> {
  const box = getSecretBox(c.config.ENCRYPTION_KEYS);
  const ciphertext = box.encrypt(JSON.stringify(input.credentials), aad(input.vendorId, input.accountId));
  const keyId = ciphertext.split('.')[1]!;
  const existing = await getAuthorizationRow(tx, input.vendorId, input.accountId);
  if (input.rotation) {
    // a token REFRESH only updates tokens of a live authorization: it must never re-create credentials the user disconnected, nor
    // switch a paused / errored account back on
    if (!existing) throw new AppError('CONFLICT', 'The marketplace was disconnected while its token was being refreshed', { details: { rule: 'authorization_removed' } });
    await tx.update(Z).set({ credentialsCiphertext: ciphertext, encryptionKeyId: keyId, accessTokenExpiresAt: input.expiresAt ?? null, lastRefreshedAt: new Date(), rotationCount: existing.rotationCount + 1, version: sql`${Z.version} + 1` }).where(eq(Z.id, existing.id));
    return;
  }
  const values = {
    authType: input.authType,
    credentialsCiphertext: ciphertext,
    encryptionKeyId: keyId,
    scopes: input.scopes ?? existing?.scopes ?? [],
    status: 'active',
    accessTokenExpiresAt: input.expiresAt ?? null,
    lastRefreshedAt: new Date(),
    lastErrorCode: null,
    lastErrorAt: null,
  };
  if (existing) {
    await tx.update(Z).set({ ...values, rotationCount: input.rotation ? existing.rotationCount + 1 : existing.rotationCount, version: sql`${Z.version} + 1` }).where(eq(Z.id, existing.id));
  } else {
    await tx.insert(Z).values({ vendorId: input.vendorId, marketplaceAccountId: input.accountId, ...values });
  }
  await tx
    .update(A)
    .set({
      status: 'active', connectionStatus: 'connected', lastSuccessAt: new Date(), lastFailureMessage: null,
      ...(input.externalAccountId ? { externalAccountId: input.externalAccountId } : {}),
    })
    .where(eq(A.id, input.accountId));
}

/** Decrypts stored credentials. Only the connector host calls this; nothing in the HTTP layer does. */
export async function loadCredentials(tx: Tx, c: Container, vendorId: string, accountId: string): Promise<{ credentials: ConnectorCredentials; authorization: AuthorizationRow; reencrypted: boolean } | null> {
  const z = await getAuthorizationRow(tx, vendorId, accountId);
  if (!z || z.status === 'revoked') return null;
  const box = getSecretBox(c.config.ENCRYPTION_KEYS);
  const credentials = JSON.parse(box.decrypt(z.credentialsCiphertext, aad(vendorId, accountId))) as ConnectorCredentials;
  let reencrypted = false;
  if (box.needsRotation(z.credentialsCiphertext)) {
    // lazy key rotation: rewrite with the active key the first time an old-key record is read
    const next = box.encrypt(JSON.stringify(credentials), aad(vendorId, accountId));
    await tx.update(Z).set({ credentialsCiphertext: next, encryptionKeyId: next.split('.')[1]! }).where(eq(Z.id, z.id));
    reencrypted = true;
  }
  return { credentials, authorization: z, reencrypted };
}

export async function recordSuccess(tx: Tx, vendorId: string, accountId: string): Promise<void> {
  await tx.update(A).set({ connectionStatus: 'connected', lastSuccessAt: new Date() }).where(and(eq(A.id, accountId), eq(A.vendorId, vendorId)));
}

export async function recordFailure(tx: Tx, vendorId: string, accountId: string, f: { message: string; code: string; authFailed: boolean }): Promise<void> {
  await tx
    .update(A)
    .set({ connectionStatus: f.authFailed ? 'error' : 'degraded', lastFailureAt: new Date(), lastFailureMessage: f.message.slice(0, 500), ...(f.authFailed ? { status: 'error' } : {}) })
    .where(and(eq(A.id, accountId), eq(A.vendorId, vendorId)));
  if (f.authFailed) {
    await tx.update(Z).set({ status: 'expired', lastErrorCode: f.code, lastErrorAt: new Date() }).where(and(eq(Z.vendorId, vendorId), eq(Z.marketplaceAccountId, accountId)));
  }
}

/** Disconnect: destroys the stored credentials (they cannot be recovered) and marks the account revoked. */
export async function clearAuthorization(tx: Tx, vendorId: string, accountId: string): Promise<void> {
  await tx.delete(Z).where(and(eq(Z.vendorId, vendorId), eq(Z.marketplaceAccountId, accountId)));
  await tx.update(A).set({ status: 'revoked', connectionStatus: 'disconnected' }).where(and(eq(A.id, accountId), eq(A.vendorId, vendorId)));
}

export async function markAuthorizationExpiring(tx: Tx, vendorId: string, accountId: string): Promise<void> {
  await tx.update(Z).set({ status: 'expiring' }).where(and(eq(Z.vendorId, vendorId), eq(Z.marketplaceAccountId, accountId), eq(Z.status, 'active')));
}


// ------------------------------------------------------------------------------------------------
// inbound-webhook signing secret (one per account; shown to the vendor ONCE, stored encrypted, AAD-bound)
// ------------------------------------------------------------------------------------------------
const webhookAad = (vendorId: string, accountId: string) => `webhook_secret:${vendorId}:${accountId}`;

export async function saveWebhookSecret(tx: Tx, c: Container, vendorId: string, accountId: string, secret: string): Promise<Date> {
  await getAccountRow(tx, vendorId, accountId);
  const at = new Date();
  await tx.update(A).set({ webhookSecretCiphertext: getSecretBox(c.config.ENCRYPTION_KEYS).encrypt(secret, webhookAad(vendorId, accountId)), webhookSecretRotatedAt: at }).where(and(eq(A.id, accountId), eq(A.vendorId, vendorId)));
  return at;
}

/** decrypts the account's webhook secret (null when none was generated). Used only by webhook verification. */
export function readWebhookSecret(c: Container, account: Pick<AccountRow, 'id' | 'vendorId' | 'webhookSecretCiphertext'>): string | null {
  if (!account.webhookSecretCiphertext) return null;
  return getSecretBox(c.config.ENCRYPTION_KEYS).decrypt(account.webhookSecretCiphertext, webhookAad(account.vendorId, account.id));
}
