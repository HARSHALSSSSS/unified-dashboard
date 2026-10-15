import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

type AnyPgDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Creates (or promotes) a platform staff user. Used by the `db:create-admin` CLI: platform admins can never be
 * created through the public API. `passwordHash` must already be an argon2id hash.
 */
export async function createPlatformUser(
  db: AnyPgDb,
  input: { email: string; fullName: string; passwordHash: string; roleKey?: 'platform_admin' | 'platform_support' },
): Promise<{ id: string; created: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.scope', 'system', true)`);
    const email = input.email.trim().toLowerCase();
    const roleKey = input.roleKey ?? 'platform_admin';
    const [role] = await tx.select().from(schema.roles).where(and(isNull(schema.roles.vendorId), eq(schema.roles.key, roleKey)));
    if (!role) throw new Error(`System role ${roleKey} not found: run db:seed first`);

    const [existing] = await tx.select().from(schema.users).where(and(sql`lower(${schema.users.email}) = ${email}`, isNull(schema.users.deletedAt)));
    let id: string;
    let created = false;
    if (existing) {
      if (existing.userType !== 'platform') throw new Error('A vendor user with this e-mail already exists');
      id = existing.id;
      await tx.update(schema.users).set({ passwordHash: input.passwordHash, status: 'active', fullName: input.fullName }).where(eq(schema.users.id, id));
    } else {
      const [u] = await tx
        .insert(schema.users)
        .values({ email, fullName: input.fullName, passwordHash: input.passwordHash, userType: 'platform', vendorId: null, status: 'active', emailVerifiedAt: new Date() })
        .returning({ id: schema.users.id });
      id = u!.id;
      created = true;
    }
    await tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, id));
    await tx.insert(schema.userRoles).values({ userId: id, roleId: role.id, vendorId: null });
    return { id, created };
  });
}
