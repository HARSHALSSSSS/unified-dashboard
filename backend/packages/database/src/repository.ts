import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { AppError, type TenantScope } from '@oms/shared';

/**
 * Repository-level tenant filtering (defence layer 2; RLS in Postgres is layer 3).
 *
 *   const where = tenantWhere(products, scope, notDeleted(products), eq(products.status, 'active'));
 *
 * - vendor scope  -> adds `vendor_id = $scope.vendorId`
 * - platform/system scope -> no vendor predicate (cross-tenant on purpose; callers must be authorised + audited)
 */
type TenantTable = { vendorId: PgColumn };
type SoftDeletable = { deletedAt: PgColumn };

export function tenantWhere(table: TenantTable, scope: TenantScope, ...conditions: (SQL | undefined)[]): SQL | undefined {
  const base = scope.kind === 'vendor' ? [eq(table.vendorId, scope.vendorId)] : [];
  return and(...base, ...conditions);
}

export const notDeleted = (table: SoftDeletable): SQL => isNull(table.deletedAt);

/** For INSERTs: the vendor id always comes from the trusted scope, never from request bodies. */
export function requireVendorId(scope: TenantScope): string {
  if (scope.kind !== 'vendor') {
    throw new AppError('BAD_REQUEST', 'A vendor context is required for this operation');
  }
  return scope.vendorId;
}

/** Optimistic concurrency helper: `.where(and(eq(id), versionIs(table, expected)))` then check affected rows. */
export const versionIs = (table: { version: PgColumn }, expected: number): SQL => eq(table.version, expected);
