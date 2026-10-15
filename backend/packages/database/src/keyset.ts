import { and, asc, desc, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { AppError, decodeCursor, encodeCursor } from '@oms/shared';

export type SortKind = 'timestamp' | 'text' | 'number';
export interface SortableColumn { column: PgColumn; kind: SortKind }

export interface KeysetInput {
  /** whitelist: API sort field name -> column */
  sorts: Record<string, SortableColumn>;
  idColumn: PgColumn;
  /** parsed `?sort=` entries (only the FIRST is used: keyset pagination needs one total order) */
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  defaultSort: { field: string; direction: 'asc' | 'desc' };
  cursor?: string;
  limit: number;
}

export interface Keyset<Row> {
  /** extra predicate to AND into the query (cursor condition) */
  where: SQL | undefined;
  orderBy: SQL[];
  /** fetch this many rows (limit + 1 lookahead) */
  fetch: number;
  /** trims the lookahead row and produces the next cursor */
  finish(rows: Row[], keyOf: (row: Row) => { sortValue: unknown; id: string }): { items: Row[]; nextCursor: string | null };
}

const cast: Record<SortKind, string> = { timestamp: 'timestamptz', text: 'text', number: 'numeric' };

/**
 * Keyset (a.k.a. seek) pagination on ONE sort column + id tiebreaker, in the requested direction.
 * Cursor = base64url([field, direction, sortValue, id]); reusing a cursor with a different sort is a 400.
 * Only NOT NULL columns may be registered as sortable.
 */
export function keyset<Row>(input: KeysetInput): Keyset<Row> {
  const chosen = input.sort?.[0] ?? input.defaultSort;
  const spec = input.sorts[chosen.field];
  if (!spec) throw new AppError('BAD_REQUEST', `Cannot sort by "${chosen.field}"`, { details: { allowed: Object.keys(input.sorts) } });
  const dir = chosen.direction;
  const order = dir === 'desc' ? desc : asc;

  let where: SQL | undefined;
  if (input.cursor) {
    const [field, cdir, value, id] = decodeCursor<[string, string, string | number, string]>(input.cursor);
    if (field !== chosen.field || cdir !== dir || typeof id !== 'string') {
      throw new AppError('BAD_REQUEST', 'Cursor does not match the requested sort', { details: { field: 'cursor' } });
    }
    const op = dir === 'desc' ? sql.raw('<') : sql.raw('>');
    where = sql`(${spec.column}, ${input.idColumn}) ${op} (${sql`${value}`}::${sql.raw(cast[spec.kind])}, ${id}::uuid)`;
  }

  return {
    where,
    orderBy: [order(spec.column), order(input.idColumn)],
    fetch: input.limit + 1,
    finish(rows, keyOf) {
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items[items.length - 1];
      if (!hasMore || !last) return { items, nextCursor: null };
      const { sortValue, id } = keyOf(last);
      const v = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
      return { items, nextCursor: encodeCursor([chosen.field, dir, v, id]) };
    },
  };
}

/** Escape LIKE wildcards so user input is matched literally. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const andAll = (...conds: (SQL | undefined)[]): SQL | undefined => and(...conds);
