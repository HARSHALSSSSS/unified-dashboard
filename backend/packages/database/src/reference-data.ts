import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { PERMISSIONS, SYSTEM_ROLES } from '@oms/auth';
import * as schema from './schema';

type AnyPgDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Idempotent reference data: permission catalogue, system roles and their grants.
 * Runs under SYSTEM scope (RLS-aware) so it also works when RLS is enforced for the connecting role.
 * Grants are reconciled (removing a permission from a system role in code revokes it here), not just appended.
 */
export async function seedReferenceData(db: AnyPgDb): Promise<{ permissions: number; roles: number }> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.scope', 'system', true)`);

    await tx
      .insert(schema.permissions)
      .values(PERMISSIONS.map((key) => ({ key, module: key.split(':')[0]!, description: null })))
      .onConflictDoNothing();

    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const existing = await tx.select().from(schema.roles).where(and(isNull(schema.roles.vendorId), eq(schema.roles.key, key)));
      const role = existing[0] ?? (await tx.insert(schema.roles).values({ key, name: def.name, isSystem: true, vendorId: null }).returning())[0]!;
      await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, role.id));
      await tx.insert(schema.rolePermissions).values(def.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })));
    }
  });
  return { permissions: PERMISSIONS.length, roles: Object.keys(SYSTEM_ROLES).length };
}
