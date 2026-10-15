import { AppError } from './errors';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Opaque keyset cursor: base64url(JSON([sortValue, id])). Clients must treat it as opaque. */
export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor<T extends unknown[] = unknown[]>(cursor: string): T {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(v)) throw new Error('not an array');
    return v as T;
  } catch {
    throw new AppError('BAD_REQUEST', 'Invalid pagination cursor', { details: { field: 'cursor' } });
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Fetch limit+1 rows, then call this to trim and compute the next cursor. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => unknown[]): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null };
}
