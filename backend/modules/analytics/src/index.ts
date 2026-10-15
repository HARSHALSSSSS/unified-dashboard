import type { JobHandler } from '@oms/module-kit';
import { manifest } from './manifest';
import { analyticsRoutes } from './routes';
import { rollupRecent } from './rollup';

export { manifest };
export { analyticsRoutes } from './routes';
export { overview, productPerformance, marketplacePerformance, dailyUnits, dailyRevenueSeries } from './queries';
export { inventoryHealth, productHealth, businessHealth, classifyStock, healthScore, stockLines, DEFAULT_THRESHOLDS, type InventoryFinding, type InventoryThresholds, type HealthIssue } from './health';
export { profitability, computeProfit, type Profit } from './profit';
export { rollupRecent, rollupVendor } from './rollup';

export const JOB_ROLLUP = 'analytics.rollup';

/** every 15 minutes: recompute today and yesterday for all vendors from the operational tables (one statement per read model) */
const jobs: JobHandler[] = [{
  queue: 'maintenance',
  name: JOB_ROLLUP,
  async handle(_env, c) { const w = await rollupRecent(c, 2); c.logger.debug({ window: w }, 'analytics roll-up'); },
}];

/**
 * Analytics: the reporting / aggregation layer. Dashboards read small daily roll-ups instead of scanning orders; profitability keeps
 * actual, estimated and missing data apart; product, inventory and business health find problems in the real data.
 */
export const analyticsModule = { manifest, routes: analyticsRoutes, jobs };
