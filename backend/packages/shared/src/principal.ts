/**
 * Request-scoped identity & tenant context. Built by the auth plugin, consumed by services & repositories.
 *
 * Scopes:
 *  - vendor   : acting inside exactly one vendor (tenant). Vendor owners/staff.
 *  - platform : platform staff, cross-tenant (every access is audited).
 *  - system   : internal workers/schedulers acting without a user (never derivable from HTTP input).
 */
export type ActorType = 'user' | 'api_key' | 'system' | 'webhook';
export type UserType = 'vendor' | 'platform';

export interface Principal {
  actorType: ActorType;
  /** user id / api key id / worker name */
  actorId: string;
  userType: UserType | null;
  /** The tenant the principal belongs to (null for platform staff and system). */
  vendorId: string | null;
  roles: string[];
  permissions: ReadonlySet<string>;
  /** Set when platform staff act on behalf of a vendor (support access). Always audited. */
  actingAsVendorId?: string | null;
  sessionId?: string;
}

export type TenantScope =
  | { kind: 'vendor'; vendorId: string }
  | { kind: 'platform' }
  | { kind: 'system' };

export interface RequestContext {
  requestId: string;
  correlationId: string;
  principal: Principal | null;
  scope: TenantScope | null;
  ip?: string;
  userAgent?: string;
}

/** Effective tenant scope for a principal; null means "no usable scope" and must be rejected. */
export function resolveScope(p: Principal): TenantScope | null {
  if (p.userType === 'platform') {
    return p.actingAsVendorId ? { kind: 'vendor', vendorId: p.actingAsVendorId } : { kind: 'platform' };
  }
  if (p.actorType === 'system') return { kind: 'system' };
  return p.vendorId ? { kind: 'vendor', vendorId: p.vendorId } : null;
}
