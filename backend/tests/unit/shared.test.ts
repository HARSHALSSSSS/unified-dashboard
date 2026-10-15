import { describe, expect, it } from 'vitest';
import { AppError, decodeCursor, encodeCursor, Errors, isUuid, newId, resolveScope, toPage, type Principal } from '@oms/shared';

describe('errors', () => {
  it('maps codes to stable http statuses', () => {
    expect(new AppError('NOT_FOUND').status).toBe(404);
    expect(new AppError('FORBIDDEN').status).toBe(403);
    expect(new AppError('VALIDATION_FAILED').status).toBe(400);
    expect(new AppError('IDEMPOTENCY_KEY_REUSED').status).toBe(422);
    expect(Errors.notFound('Product', 'x').details).toEqual({ resource: 'Product', id: 'x' });
  });
  it('does not expose 5xx messages', () => {
    expect(new AppError('INTERNAL').expose).toBe(false);
    expect(new AppError('CONFLICT').expose).toBe(true);
  });
});

describe('ids', () => {
  it('generates sortable uuid v7', async () => {
    const a = newId();
    await new Promise((r) => setTimeout(r, 3));
    const b = newId();
    expect(isUuid(a)).toBe(true);
    expect(a < b).toBe(true);
  });
});

describe('pagination', () => {
  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(['2025-01-01', 'abc']))).toEqual(['2025-01-01', 'abc']);
    expect(() => decodeCursor('%%%')).toThrow(AppError);
  });
  it('trims the lookahead row and sets nextCursor', () => {
    const rows = [1, 2, 3].map((id) => ({ id }));
    const page = toPage(rows, 2, (r) => [r.id]);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor!)).toEqual([2]);
    expect(toPage(rows.slice(0, 2), 2, (r) => [r.id]).nextCursor).toBeNull();
  });
});

describe('tenant scope resolution', () => {
  const base: Principal = { actorType: 'user', actorId: 'u', userType: 'vendor', vendorId: 'v1', roles: [], permissions: new Set() };
  it('vendor users are pinned to their vendor', () => expect(resolveScope(base)).toEqual({ kind: 'vendor', vendorId: 'v1' }));
  it('platform staff are cross-tenant unless acting as a vendor', () => {
    const p = { ...base, userType: 'platform' as const, vendorId: null };
    expect(resolveScope(p)).toEqual({ kind: 'platform' });
    expect(resolveScope({ ...p, actingAsVendorId: 'v2' })).toEqual({ kind: 'vendor', vendorId: 'v2' });
  });
  it('a vendor user can never become platform scope via actingAsVendorId', () => {
    expect(resolveScope({ ...base, actingAsVendorId: 'v2' })).toEqual({ kind: 'vendor', vendorId: 'v1' });
  });
  it('vendor user without a vendor has no scope', () => expect(resolveScope({ ...base, vendorId: null })).toBeNull());
});
