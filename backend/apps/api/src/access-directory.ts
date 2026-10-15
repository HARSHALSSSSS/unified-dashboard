import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { schema, withSystem, type Database } from '@oms/database';
import { onSessionRevoked, onVendorChanged } from '@oms/shared';

export type VendorStatus = 'pending' | 'active' | 'suspended' | 'closed';

/**
 * Port used by the access hook to turn token claims into live authorisation facts.
 * Tokens carry role KEYS and a session id only; permissions, tenant status and session validity are resolved here
 * (cached) so a permission change, a vendor suspension or a logout takes effect within the cache TTL (or instantly
 * in-process for logouts) instead of waiting for token expiry.
 */
export interface AccessDirectory {
  permissionsFor(roleKeys: string[], vendorId: string | null): Promise<ReadonlySet<string>>;
  vendorStatus(vendorId: string): Promise<VendorStatus | null>;
  /** false when the login session (refresh-token family) was revoked/expired. Optional for test doubles. */
  sessionActive?(sessionId: string): Promise<boolean>;
}

class TtlCache<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();
  constructor(private readonly ttlMs: number, private readonly max = 5000) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.map.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: V): void {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(k, { v, exp: Date.now() + this.ttlMs });
  }
  delete(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

export class DbAccessDirectory implements AccessDirectory {
  private readonly perms = new TtlCache<ReadonlySet<string>>(60_000);
  private readonly status = new TtlCache<VendorStatus | null>(30_000);
  private readonly sessions = new TtlCache<boolean>(15_000);

  constructor(private readonly database: Database) {
    // Logout / password change in THIS process invalidates immediately; other replicas converge within the TTL.
    onSessionRevoked((sid) => this.sessions.delete(sid));
    onVendorChanged((vid) => this.status.delete(vid));
  }

  /** Drop cached tenant status (e.g. right after a platform admin suspends a vendor in this process). */
  invalidateVendor(vendorId: string): void { this.status.delete(vendorId); }
  invalidatePermissions(): void { this.perms.clear(); }

  async permissionsFor(roleKeys: string[], vendorId: string | null): Promise<ReadonlySet<string>> {
    if (roleKeys.length === 0) return new Set();
    const cacheKey = `${vendorId ?? '-'}|${[...roleKeys].sort().join(',')}`;
    const hit = this.perms.get(cacheKey);
    if (hit) return hit;
    const rows = await withSystem(this.database.db, (tx) =>
      tx
        .select({ key: schema.rolePermissions.permissionKey })
        .from(schema.rolePermissions)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.rolePermissions.roleId))
        .where(and(inArray(schema.roles.key, roleKeys), vendorId ? or(isNull(schema.roles.vendorId), eq(schema.roles.vendorId, vendorId)) : isNull(schema.roles.vendorId))),
    );
    const set = new Set(rows.map((r) => r.key));
    this.perms.set(cacheKey, set);
    return set;
  }

  async vendorStatus(vendorId: string): Promise<VendorStatus | null> {
    const hit = this.status.get(vendorId);
    if (hit !== undefined) return hit;
    const rows = await withSystem(this.database.db, (tx) =>
      tx.select({ status: schema.vendors.status }).from(schema.vendors).where(and(eq(schema.vendors.id, vendorId), isNull(schema.vendors.deletedAt))),
    );
    const s = (rows[0]?.status as VendorStatus | undefined) ?? null;
    this.status.set(vendorId, s);
    return s;
  }

  async sessionActive(sessionId: string): Promise<boolean> {
    const hit = this.sessions.get(sessionId);
    if (hit !== undefined) return hit;
    const rows = await withSystem(this.database.db, (tx) =>
      tx
        .select({ id: schema.refreshTokens.id })
        .from(schema.refreshTokens)
        .where(and(eq(schema.refreshTokens.familyId, sessionId), isNull(schema.refreshTokens.revokedAt), gt(schema.refreshTokens.expiresAt, new Date())))
        .limit(1),
    );
    const active = rows.length > 0;
    this.sessions.set(sessionId, active);
    return active;
  }
}

/** Fixed in-memory directory for unit/API tests. */
export class StaticAccessDirectory implements AccessDirectory {
  constructor(
    private readonly rolePermissions: Record<string, string[]> = {},
    private readonly vendors: Record<string, VendorStatus> = {},
  ) {}
  async permissionsFor(roleKeys: string[]): Promise<ReadonlySet<string>> {
    return new Set(roleKeys.flatMap((r) => this.rolePermissions[r] ?? []));
  }
  async vendorStatus(vendorId: string): Promise<VendorStatus | null> {
    return this.vendors[vendorId] ?? null;
  }
}
