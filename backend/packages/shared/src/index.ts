import { v7 as uuidv7, validate } from 'uuid';

export * from './errors';
export * from './principal';
export * from './pagination';

/** Time-ordered UUID (v7): index-friendly (no random page splits) and still globally unique. */
export const newId = (): string => uuidv7();
export const isUuid = (v: string): boolean => validate(v);

/** Injectable time source so domain logic is deterministic in tests. */
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

/** In-process notifications when a login session is revoked, so caches (access directory) drop it immediately. */
type SessionListener = (sessionId: string) => void;
const sessionListeners = new Set<SessionListener>();
export const onSessionRevoked = (l: SessionListener): (() => void) => { sessionListeners.add(l); return () => sessionListeners.delete(l); };
export const notifySessionRevoked = (sessionId: string): void => { for (const l of sessionListeners) l(sessionId); };

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();
export const slugify = (s: string, max = 48): string =>
  s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'item';

/** In-process notifications when a vendor's status changes, so the access directory drops its cached status. */
const vendorListeners = new Set<(vendorId: string) => void>();
export const onVendorChanged = (l: (vendorId: string) => void): (() => void) => { vendorListeners.add(l); return () => vendorListeners.delete(l); };
export const notifyVendorChanged = (vendorId: string): void => { for (const l of vendorListeners) l(vendorId); };
