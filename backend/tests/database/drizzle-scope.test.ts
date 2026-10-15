import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireVendorId, schema, seedReferenceData, tenantWhere, withScope, withSystem, withVendor, type Db } from '@oms/database';
import { PERMISSIONS, SYSTEM_ROLES } from '@oms/auth';
import { AppError } from '@oms/shared';

/**
 * Exercises the REAL @oms/database code (withScope, repository helpers, seed) through Drizzle on PGlite, with the
 * connection switched to the non-owner runtime role so RLS applies exactly as in production.
 */
const MIGRATIONS = resolve(__dirname, '../../packages/database/migrations');
const A = '11111111-1111-7111-8111-111111111111';
const B = '22222222-2222-7222-8222-222222222222';

let pg: PGlite;
let db: Db;

beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec('CREATE ROLE oms_app NOLOGIN');
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    for (const stmt of readFileSync(resolve(MIGRATIONS, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
  }
  await seedReferenceData(drizzle(pg, { schema }) as never); // as owner/superuser, under system scope
  await pg.exec(`
    INSERT INTO vendors (id, slug, legal_name, display_name, status) VALUES ('${A}', 'a', 'A', 'A', 'active'), ('${B}', 'b', 'B', 'B', 'active');
    INSERT INTO products (vendor_id, product_code, title) VALUES ('${A}', 'P-A', 'A product'), ('${B}', 'P-B', 'B product');
  `);
  await pg.exec('SET ROLE oms_app'); // from here on, behave like the application
  db = drizzle(pg, { schema }) as unknown as Db;
});
afterAll(() => pg.close());

describe('seedReferenceData', () => {
  it('seeds the permission catalogue and system roles with their grants, idempotently', async () => {
    await pg.exec('RESET ROLE');
    const owner = drizzle(pg, { schema });
    const again = await seedReferenceData(owner as never);
    expect(again).toEqual({ permissions: PERMISSIONS.length, roles: Object.keys(SYSTEM_ROLES).length });
    expect(await owner.select().from(schema.permissions)).toHaveLength(PERMISSIONS.length);
    expect(await owner.select().from(schema.roles)).toHaveLength(Object.keys(SYSTEM_ROLES).length);
    const expectedGrants = Object.values(SYSTEM_ROLES).reduce((n, r) => n + r.permissions.length, 0);
    expect(await owner.select().from(schema.rolePermissions)).toHaveLength(expectedGrants);
    await pg.exec('SET ROLE oms_app');
  });
});

describe('withScope through Drizzle (RLS active)', () => {
  it('vendor scope sees only its rows', async () => {
    const rows = await withVendor(db, A, (tx) => tx.select().from(schema.products));
    expect(rows.map((r) => r.productCode)).toEqual(['P-A']);
  });

  it('scope never leaks between transactions on the same connection', async () => {
    await withVendor(db, A, (tx) => tx.select().from(schema.products));
    expect(await db.select().from(schema.products)).toHaveLength(0); // no scope => fail closed
    const rows = await withVendor(db, B, (tx) => tx.select().from(schema.products));
    expect(rows.map((r) => r.productCode)).toEqual(['P-B']);
  });

  it('system and platform scopes are cross-tenant', async () => {
    expect(await withSystem(db, (tx) => tx.select().from(schema.products))).toHaveLength(2);
    expect(await withScope(db, { kind: 'platform' }, (tx) => tx.select().from(schema.products))).toHaveLength(2);
  });

  it('repository helpers: tenantWhere narrows, requireVendorId guards inserts', async () => {
    const rows = await withSystem(db, (tx) =>
      tx.select().from(schema.products).where(tenantWhere(schema.products, { kind: 'vendor', vendorId: B })),
    );
    expect(rows.map((r) => r.productCode)).toEqual(['P-B']);
    expect(() => requireVendorId({ kind: 'platform' })).toThrow(AppError);
    expect(requireVendorId({ kind: 'vendor', vendorId: A })).toBe(A);
  });

  it('a vendor-scoped insert for another vendor is rejected by the database', async () => {
    await expect(
      withVendor(db, A, (tx) => tx.insert(schema.products).values({ vendorId: B, productCode: 'X', title: 'x' })),
    ).rejects.toThrow();
  });

  it('a failed transaction rolls back and does not poison later scopes', async () => {
    await expect(
      withVendor(db, A, async (tx) => {
        await tx.insert(schema.products).values({ vendorId: A, productCode: 'P-TMP', title: 't' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await withVendor(db, A, (tx) => tx.select().from(schema.products).where(eq(schema.products.productCode, 'P-TMP')));
    expect(rows).toHaveLength(0);
  });
});
