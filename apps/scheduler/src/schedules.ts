/**
 * Central schedule catalogue (single source of truth).
 */
export interface ScheduleDef {
  id: string;
  queue: 'maintenance' | 'syncMarketplace' | 'notifications' | 'heavy';
  job: string;
  /** fixed interval in ms OR a cron pattern (evaluated in Asia/Kolkata) */
  every?: number;
  cron?: string;
  data?: unknown;
}

export const SCHEDULES: ScheduleDef[] = [
  // Stage 2: rotate marketplace tokens that expire within 15 minutes (connectors module)
  { id: 'maintenance:refresh-marketplace-tokens', queue: 'maintenance', job: 'marketplace.refresh-expiring-tokens', every: 5 * 60 * 1000 },
  // Stage 3: fan-out. The handlers enqueue ONE idempotent sync job per account per interval (time-bucketed key), so running
  // these every minute (or from two scheduler replicas) never produces duplicate work.
  { id: 'maintenance:sync-orders-fanout', queue: 'maintenance', job: 'sync.schedule-orders', every: 60 * 1000 },
  { id: 'maintenance:sync-listing-status-fanout', queue: 'maintenance', job: 'sync.schedule-listing-status', every: 2 * 60 * 1000 },
  { id: 'maintenance:sync-inventory-reconcile', queue: 'maintenance', job: 'sync.schedule-inventory', every: 2 * 60 * 1000 },
  { id: 'maintenance:shipping-tracking', queue: 'maintenance', job: 'shipping.poll-tracking', every: 5 * 60 * 1000 },
  { id: 'maintenance:billing-invoice-run', queue: 'maintenance', job: 'billing.invoice-run', every: 60 * 60 * 1000 },
  { id: 'maintenance:analytics-rollup', queue: 'maintenance', job: 'analytics.rollup', every: 15 * 60 * 1000 },
  { id: 'maintenance:pricing-sales', queue: 'maintenance', job: 'pricing.process-sales', every: 60 * 1000 },
  { id: 'maintenance:sync-sweep', queue: 'maintenance', job: 'sync.sweep', every: 5 * 60 * 1000 },
  { id: 'maintenance:webhooks-sweep', queue: 'maintenance', job: 'webhooks.sweep', every: 2 * 60 * 1000 },
  { id: 'maintenance:purge-idempotency-keys', queue: 'maintenance', job: 'purge-idempotency-keys', every: 60 * 60 * 1000 },
  { id: 'maintenance:purge-refresh-tokens', queue: 'maintenance', job: 'purge-refresh-tokens', cron: '30 3 * * *' },
  { id: 'maintenance:purge-published-outbox', queue: 'maintenance', job: 'purge-published-outbox', cron: '45 3 * * *' },
];
