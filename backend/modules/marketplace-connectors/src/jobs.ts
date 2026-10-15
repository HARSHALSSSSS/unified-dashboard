import { and, eq, inArray, lt, schema, withSystem } from '@oms/database';
import type { JobHandler } from '@oms/module-kit';
import { ConnectorHost } from './host';

/** Tokens expiring within this window are rotated by the scheduled job (the host also refreshes lazily on use). */
const WINDOW_MS = 15 * 60_000;
const BATCH = 200;

export const JOB_REFRESH_EXPIRING = 'marketplace.refresh-expiring-tokens';

/**
 * Scheduled token maintenance (apps/scheduler -> maintenance queue): rotates access tokens that are about to expire so
 * background syncs never start with a dead token, and flags connections whose refresh keeps failing (the host marks
 * the authorization expired and emits `marketplace_account.authorization_expired` for notifications).
 */
export const refreshExpiringTokensHandler: JobHandler = {
  queue: 'maintenance',
  name: JOB_REFRESH_EXPIRING,
  async handle(_env, c) {
    const host = new ConnectorHost(c);
    const Z = schema.marketplaceAuthorizations;
    const due = await withSystem(c.database.db, (tx) =>
      tx
        .select({ vendorId: Z.vendorId, accountId: Z.marketplaceAccountId })
        .from(Z)
        .innerJoin(schema.marketplaceAccounts, and(eq(schema.marketplaceAccounts.id, Z.marketplaceAccountId), eq(schema.marketplaceAccounts.vendorId, Z.vendorId)))
        .where(and(inArray(Z.status, ['active', 'expiring']), eq(schema.marketplaceAccounts.status, 'active'), lt(Z.accessTokenExpiresAt, new Date(Date.now() + WINDOW_MS))))
        .limit(BATCH),
    );
    let refreshed = 0;
    let failed = 0;
    for (const { vendorId, accountId } of due) {
      try {
        await host.refresh(vendorId, accountId);
        refreshed++;
      } catch (err) {
        failed++; // recorded on the account by the host; keep going with the others
        c.logger.warn({ accountId, vendorId, err: (err as Error).message }, 'scheduled token refresh failed');
      }
    }
    c.logger.info({ due: due.length, refreshed, failed }, 'token maintenance finished');
  },
};
