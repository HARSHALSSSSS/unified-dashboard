import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableName, is } from 'drizzle-orm';
import { PgTable as PgTableClass } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from '@oms/database';

/** Guards the database conventions so every future table follows them (docs/database/DATABASE.md). */
const tables = Object.values(schema).filter((v) => is(v, PgTableClass)) as any[];
const cfg = tables.map((t) => { const c = getTableConfig(t); return { ...c, name: getTableName(t) }; });
const tenantTables = cfg.filter((t) => t.columns.some((c) => c.name === 'vendor_id') && t.name !== 'vendors');

describe('schema conventions', () => {
  it('has tables', () => expect(cfg.length).toBeGreaterThanOrEqual(20));

  it('uses snake_case plural-ish table and column names', () => {
    for (const t of cfg) {
      expect(t.name, t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const c of t.columns) expect(c.name, `${t.name}.${c.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('every mutable tenant table has timestamptz created_at/updated_at', () => {
    const immutable = new Set(['sync_logs', 'inventory_movements', 'order_status_events', 'fulfillment_events', 'shipment_tracking_events', 'return_events', 'rule_executions', 'price_history', 'audit_logs', 'user_roles', 'refresh_tokens', 'idempotency_keys', 'outbox_events', 'category_attributes']);
    for (const t of tenantTables.filter((x) => !immutable.has(x.name))) {
      const names = t.columns.map((c) => c.name);
      expect(names, t.name).toContain('created_at');
      expect(names, t.name).toContain('updated_at');
    }
  });

  it('every tenant table has an index that STARTS with vendor_id (tenant-scoped access path)', () => {
    for (const t of tenantTables) {
      const leading = t.indexes.some((i) => i.config.columns[0] && 'name' in i.config.columns[0] && i.config.columns[0].name === 'vendor_id');
      const pkLead = t.primaryKeys.some((p) => p.columns[0]?.name === 'vendor_id');
      // idempotency_keys leads with an expression on vendor_id; sync/outbox use composite leads - allow explicit exceptions
      const exceptions = new Set(['idempotency_keys', 'roles', 'refresh_tokens', 'user_roles']);
      expect(leading || pkLead || exceptions.has(t.name), `${t.name} lacks a vendor_id-leading index`).toBe(true);
    }
  });

  it('children of tenant tables use composite (vendor_id, id) foreign keys', () => {
    const composite = cfg.flatMap((t) => t.foreignKeys.map((fk) => ({ t: t.name, fk: fk.reference() }))).filter((x) => x.fk.columns.length === 2);
    // at minimum these cross-entity links must be tenant-safe
    const names = composite.map((x) => `${x.t}.${x.fk.columns.map((c) => c.name).join('+')}`);
    for (const expected of ['product_variants.vendor_id+product_id', 'inventory.vendor_id+variant_id', 'inventory.vendor_id+warehouse_id', 'order_items.vendor_id+order_id', 'orders.vendor_id+marketplace_account_id', 'marketplace_listings.vendor_id+variant_id', 'marketplace_authorizations.vendor_id+marketplace_account_id', 'sync_logs.vendor_id+sync_job_id']) {
      expect(names).toContain(expected);
    }
  });

  it('money columns are integer minor units, never floating point', () => {
    for (const t of cfg) for (const c of t.columns) {
      if (/(price|amount|total|tax|discount|cost|mrp|shipping)/.test(c.name) && !c.name.endsWith('_bps') && !c.name.endsWith('_id') && !c.name.endsWith('_address') && !c.name.includes('_seconds_')) {
        expect(c.name, `${t.name}.${c.name}`).toMatch(/_minor$/);
        expect(c.getSQLType(), `${t.name}.${c.name}`).toBe('bigint');
      }
    }
  });
});
