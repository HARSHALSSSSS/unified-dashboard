import type { EventConsumer, JobHandler } from '@oms/module-kit';
import { withVendor } from '@oms/database';
import { manifest } from './manifest';
import { billingRoutes } from './routes';
import { ensureSubscription, recordUsage, runInvoicing } from './service';

export { manifest };
export { billingRoutes } from './routes';
export { enforceLimit, recordUsage, getSubscription, usageReport } from './service';

/** new vendors start on the free plan; every order is metered (decoupled: billing only LISTENS to the commerce engine) */
const consumers: EventConsumer[] = [
  { event: 'vendor.created', name: 'billing.subscribe-new-vendor', async handle(e, c) { if (e.vendorId) await withVendor(c.database.db, e.vendorId, (tx) => ensureSubscription(tx, e.vendorId!)); } },
  { event: 'order.created', name: 'billing.meter-orders', async handle(e, c) { if (e.vendorId) await withVendor(c.database.db, e.vendorId, (tx) => recordUsage(tx, e.vendorId!, 'orders', 1, new Date(e.occurredAt))); } },
];

export const JOB_INVOICE_RUN = 'billing.invoice-run';
const jobs: JobHandler[] = [{ queue: 'maintenance', name: JOB_INVOICE_RUN, async handle(_env, c) { const r = await runInvoicing(c); if (r.invoiced || r.cancelled) c.logger.info(r, 'billing run'); } }];

/**
 * Billing: plans with feature limits, subscriptions, usage metering, invoices and payment status. Separate from the commerce engine:
 * it consumes events and is consulted through `enforceLimit` (off unless the `billing.enforce_limits` flag is on).
 */
export const billingModule = { manifest, routes: billingRoutes, consumers, jobs };
