import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the REAL migrations against an in-process Postgres (PGlite, WASM) and proves the tenancy guarantees
 * at the database level: RLS isolation, fail-closed default, composite-FK cross-tenant protection,
 * append-only audit log. No Docker required, so this runs in CI and on every developer machine.
 */
const MIGRATIONS = resolve(__dirname, '../../packages/database/migrations');
const A = '11111111-1111-7111-8111-111111111111';
const B = '22222222-2222-7222-8222-222222222222';

let db: PGlite;

const asApp = async (scope: string | null, vendorId: string | null = null) => {
  await db.exec('RESET ROLE');
  await db.exec('SET ROLE oms_app');
  await db.query(`select set_config('app.scope', $1, false), set_config('app.vendor_id', $2, false)`, [scope ?? '', vendorId ?? '']);
};

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec('CREATE ROLE oms_app NOLOGIN'); // exists before migrations, like infrastructure/postgres/init.sql
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    const sql = readFileSync(resolve(MIGRATIONS, `${tag}.sql`), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await db.exec(stmt);
  }
  // superuser seeds two tenants (bypasses RLS like the migration owner would under system scope)
  await db.exec(`
    INSERT INTO vendors (id, slug, legal_name, display_name, status) VALUES
      ('${A}', 'acme', 'Acme Pvt Ltd', 'Acme', 'active'),
      ('${B}', 'globex', 'Globex Pvt Ltd', 'Globex', 'active');
    INSERT INTO products (vendor_id, product_code, title) VALUES ('${A}', 'P-A', 'Acme product'), ('${B}', 'P-B', 'Globex product');
  `);
});

afterAll(async () => {
  await db.close();
});

describe('migrations', () => {
  it('create every required foundation table', async () => {
    const { rows } = await db.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema='public'`);
    const names = rows.map((r) => r.table_name);
    for (const t of ['vendors', 'users', 'roles', 'permissions', 'products', 'product_variants', 'product_documents', 'categories', 'marketplace_accounts', 'marketplace_authorizations', 'marketplace_listings', 'inventory', 'warehouses', 'orders', 'order_items', 'sync_jobs', 'sync_logs', 'audit_logs', 'outbox_events', 'idempotency_keys', 'refresh_tokens']) {
      expect(names, t).toContain(t);
    }
  });
});

describe('row level security', () => {
  it('fails closed: no scope set => no tenant rows visible', async () => {
    await asApp(null);
    expect((await db.query('select 1 from products')).rows).toHaveLength(0);
    expect((await db.query('select 1 from vendors')).rows).toHaveLength(0);
  });

  it('vendor scope sees only its own rows', async () => {
    await asApp('vendor', A);
    const { rows } = await db.query<{ product_code: string }>('select product_code from products');
    expect(rows).toEqual([{ product_code: 'P-A' }]);
    expect((await db.query('select 1 from vendors')).rows).toHaveLength(1);
  });

  it('vendor scope cannot write a row for another tenant (WITH CHECK)', async () => {
    await asApp('vendor', A);
    await expect(db.query(`insert into products (vendor_id, product_code, title) values ('${B}', 'EVIL', 'x')`)).rejects.toThrow(/row-level security/i);
  });

  it('vendor scope cannot update or delete another tenant rows (silently 0 rows)', async () => {
    await asApp('vendor', A);
    const upd = await db.query(`update products set title = 'hacked' where vendor_id = '${B}'`);
    expect(upd.affectedRows).toBe(0);
    const del = await db.query(`delete from products where vendor_id = '${B}'`);
    expect(del.affectedRows).toBe(0);
  });

  it('platform and system scopes are cross-tenant', async () => {
    for (const scope of ['platform', 'system']) {
      await asApp(scope);
      expect((await db.query('select 1 from products')).rows).toHaveLength(2);
    }
  });

  it('system roles are readable by tenants but not writable', async () => {
    await db.exec('RESET ROLE');
    await db.exec(`insert into roles (key, name, is_system, vendor_id) values ('vendor_owner', 'Vendor Owner', true, null)`);
    await asApp('vendor', A);
    expect((await db.query('select 1 from roles where vendor_id is null')).rows).toHaveLength(1);
    await expect(db.query(`insert into roles (key, name, is_system, vendor_id) values ('x', 'x', true, null)`)).rejects.toThrow(/row-level security/i);
  });
});

describe('integrity guards', () => {
  it('composite FK rejects a child pointing at another tenant parent', async () => {
    await db.exec('RESET ROLE');
    const { rows } = await db.query<{ id: string }>(`select id from products where vendor_id = '${B}'`);
    await expect(
      db.query(`insert into product_variants (vendor_id, product_id, sku) values ('${A}', '${rows[0]!.id}', 'CROSS-1')`),
    ).rejects.toThrow(/foreign key/i);
  });

  it('SKU is unique per vendor but reusable across vendors', async () => {
    await db.exec('RESET ROLE');
    const a = (await db.query<{ id: string }>(`select id from products where vendor_id = '${A}'`)).rows[0]!.id;
    const b = (await db.query<{ id: string }>(`select id from products where vendor_id = '${B}'`)).rows[0]!.id;
    await db.exec(`insert into product_variants (vendor_id, product_id, sku) values ('${A}', '${a}', 'SKU-1'), ('${B}', '${b}', 'SKU-1')`);
    await expect(db.query(`insert into product_variants (vendor_id, product_id, sku) values ('${A}', '${a}', 'SKU-1')`)).rejects.toThrow(/unique/i);
  });

  it('marketplace order ingestion is idempotent per (account, external order id)', async () => {
    await db.exec('RESET ROLE');
    await db.exec(`insert into marketplace_accounts (id, vendor_id, marketplace, display_name) values ('33333333-3333-7333-8333-333333333333', '${A}', 'flipkart', 'FK main')`);
    const ins = `insert into orders (vendor_id, marketplace_account_id, marketplace, external_order_id, order_number, placed_at) values ('${A}', '33333333-3333-7333-8333-333333333333', 'mock', 'OD123', 'ORD-1', now())`;
    await db.exec(ins);
    await expect(db.query(ins.replace('ORD-1', 'ORD-2'))).rejects.toThrow(/unique/i);
  });

  it('rejects unknown marketplace codes and negative stock', async () => {
    await db.exec('RESET ROLE');
    await expect(db.query(`insert into marketplace_accounts (vendor_id, marketplace, display_name) values ('${A}', 'ebay', 'x')`)).rejects.toThrow(/check/i);
  });

  it('audit_logs is append-only', async () => {
    await db.exec('RESET ROLE');
    await db.exec(`insert into audit_logs (vendor_id, actor_type, action) values ('${A}', 'system', 'test.created')`);
    await expect(db.query(`update audit_logs set action = 'tampered'`)).rejects.toThrow(/append-only/i);
    await expect(db.query(`delete from audit_logs`)).rejects.toThrow(/append-only/i);
  });

  it('updated_at is maintained by trigger', async () => {
    await db.exec('RESET ROLE');
    const before = (await db.query<{ updated_at: string }>(`select updated_at from vendors where id = '${A}'`)).rows[0]!.updated_at;
    await new Promise((r) => setTimeout(r, 15));
    await db.exec(`update vendors set display_name = 'Acme 2' where id = '${A}'`);
    const after = (await db.query<{ updated_at: string }>(`select updated_at from vendors where id = '${A}'`)).rows[0]!.updated_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});

describe('enable_tenant_rls() helper for future tables', () => {
  it('gives a brand new tenant table the same isolation + updated_at trigger', async () => {
    await db.exec('RESET ROLE');
    await db.exec(`
      CREATE TABLE future_things (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vendor_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      SELECT enable_tenant_rls('future_things');
      SELECT attach_updated_at('future_things');
      GRANT ALL ON future_things TO oms_app;
      INSERT INTO future_things (vendor_id) VALUES ('${A}'), ('${B}');
    `);
    await asApp('vendor', A);
    expect((await db.query('select 1 from future_things')).rows).toHaveLength(1);
    await asApp(null);
    expect((await db.query('select 1 from future_things')).rows).toHaveLength(0);
  });
});
