import { and, eq } from 'drizzle-orm';
import { featureFlagOverrides, featureFlags } from './schema/platform-intel';
import type { Tx } from './client';

/**
 * Feature flag evaluation, usable from any module without depending on the platform-admin module:
 *   vendor override  >  platform default  >  `fallback` (flag not defined at all).
 * Writes happen only through platform administration.
 */
export async function isFeatureEnabled(tx: Tx, key: string, vendorId: string | null, fallback = false): Promise<boolean> {
  if (vendorId) {
    const [o] = await tx.select({ enabled: featureFlagOverrides.enabled }).from(featureFlagOverrides).where(and(eq(featureFlagOverrides.vendorId, vendorId), eq(featureFlagOverrides.flagKey, key)));
    if (o) return o.enabled;
  }
  const [f] = await tx.select({ d: featureFlags.defaultEnabled }).from(featureFlags).where(eq(featureFlags.key, key));
  return f ? f.d : fallback;
}

/** every flag as seen by one vendor */
export async function effectiveFlags(tx: Tx, vendorId: string): Promise<Record<string, boolean>> {
  const flags = await tx.select().from(featureFlags);
  const overrides = await tx.select().from(featureFlagOverrides).where(eq(featureFlagOverrides.vendorId, vendorId));
  return Object.fromEntries(flags.map((f) => [f.key, overrides.find((o) => o.flagKey === f.key)?.enabled ?? f.defaultEnabled]));
}
