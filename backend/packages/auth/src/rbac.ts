import { Errors, type Principal } from '@oms/shared';

/**
 * Permission catalogue: `<resource>:<action>`. This is the code-level source of truth; the `permissions`
 * table is seeded from it (db:seed). Adding an endpoint = add (or reuse) a permission here and reference it
 * in the route's `config.permission`.
 */
export const PERMISSIONS = [
  'vendors:read', 'vendors:write',
  'users:read', 'users:write',
  'roles:read', 'roles:write',
  'products:read', 'products:write', 'products:delete',
  'categories:read', 'categories:write',
  'attributes:read', 'attributes:write',
  'connectors:read',
  'documents:read', 'documents:write',
  'warehouses:read', 'warehouses:write', 'warehouses:admin',
  'inventory:read', 'inventory:write',
  'marketplace_accounts:read', 'marketplace_accounts:write',
  'listings:read', 'listings:write',
  'orders:read', 'orders:write',
  'fulfillment:read', 'fulfillment:write',
  'shipping:read', 'shipping:write', 'shipping:configure',
  'returns:read', 'returns:write', 'returns:refund',
  'pricing:read', 'pricing:write',
  'reports:read', 'analytics:read',
  'sync:read', 'sync:write',
  'webhooks:read', 'webhooks:write',
  'rules:read', 'rules:write',
  'jobs:read',
  'audit:read',
  'billing:read', 'billing:write',
  'ai:use', 'automation:read', 'automation:write',
  'notifications:read',
  // platform staff only
  'platform:vendors', 'platform:impersonate', 'platform:system',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const WRITE_SUFFIX = ':write';
const all = [...PERMISSIONS] as string[];
const vendorAll = all.filter((p) => !p.startsWith('platform:'));

/** powers that change who may do what or move money: owners / admins only (staff run day-to-day operations, not the rules of the house) */
const ADMIN_ONLY = new Set(['warehouses:admin', 'shipping:configure', 'returns:refund']);

/** System roles (vendor_id IS NULL in `roles`). Vendors can later define custom roles from the same catalogue. */
export const SYSTEM_ROLES: Record<string, { name: string; userType: 'vendor' | 'platform'; permissions: string[] }> = {
  // Business owner/administrator: everything inside their own vendor.
  vendor_admin: { name: 'Vendor Admin', userType: 'vendor', permissions: vendorAll },
  // Day-to-day operator: manages catalogue and operations, cannot manage users, billing, vendor profile or marketplace connections.
  vendor_staff: {
    name: 'Vendor Staff',
    userType: 'vendor',
    permissions: vendorAll.filter(
      (p) =>
        (['products', 'inventory', 'orders', 'fulfillment', 'shipping', 'returns', 'listings', 'documents', 'warehouses', 'categories', 'attributes'].some((r) => p.startsWith(`${r}:`)) && p !== 'products:delete' && !ADMIN_ONLY.has(p)) ||
        ['vendors:read', 'marketplace_accounts:read', 'connectors:read', 'sync:read', 'webhooks:read', 'rules:read', 'pricing:read', 'reports:read', 'analytics:read', 'notifications:read'].includes(p),
    ),
  },
  vendor_viewer: { name: 'Vendor Viewer', userType: 'vendor', permissions: vendorAll.filter((p) => p.endsWith(':read') && p !== 'users:read' && p !== 'audit:read' && p !== 'billing:read') },
  platform_admin: { name: 'Platform Admin', userType: 'platform', permissions: all },
  platform_support: { name: 'Platform Support', userType: 'platform', permissions: all.filter((p) => p.endsWith(':read') || p === 'platform:vendors' || p === 'platform:impersonate') },
};

export const hasPermission = (p: Principal, permission: string): boolean => p.permissions.has(permission);

export function assertPermission(p: Principal, permission: string): void {
  if (!hasPermission(p, permission)) throw Errors.forbidden(permission);
}

/** Convenience: true if the permission implies mutation (used for audit + read-only impersonation). */
export const isWritePermission = (permission: string): boolean => permission.endsWith(WRITE_SUFFIX) || permission.endsWith(':delete');
