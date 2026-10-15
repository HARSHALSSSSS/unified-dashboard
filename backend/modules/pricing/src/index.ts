import type { EventConsumer, JobHandler } from '@oms/module-kit';
import { manifest } from './manifest';
import { pricingRoutes } from './routes';
import { onBasePriceChanged, processSales } from './service';

export { manifest };
export { pricingRoutes } from './routes';
export { computePrice, effectivePrice, saleActive, applyChange, type PriceResult, type Change } from './domain';
export { setMarketplacePrice, processSales, applyRules, bulkUpdate, SyncWork } from './service';

export const JOB_PROCESS_SALES = 'pricing.process-sales';

/** every minute: start the sales whose window opened, end the ones that closed (each exactly once) */
const jobs: JobHandler[] = [{
  queue: 'maintenance',
  name: JOB_PROCESS_SALES,
  async handle(_env, c) {
    const r = await processSales(c);
    if (r.started || r.ended) c.logger.info(r, 'sales processed');
  },
}];

const consumers: EventConsumer[] = [{
  event: 'variant.price_changed',
  name: 'pricing.variant-price-changed',
  async handle(e, c) {
    const p = e.payload as { price?: Parameters<typeof onBasePriceChanged>[3] } | null;
    if (!e.vendorId || !p?.price) return;
    await onBasePriceChanged(c, e.vendorId, e.aggregateId, p.price);
  },
}];

/**
 * Pricing: base price on the variant, a price per marketplace account, scheduled sales, rule-driven prices, bulk updates with a
 * dry-run, and an append-only price history. Marketplaces differ: a connector that cannot take prices is skipped, not faked.
 */
export const pricingModule = { manifest, routes: pricingRoutes, jobs, consumers };
