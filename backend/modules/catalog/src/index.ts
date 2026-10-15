import type { FastifyPluginAsync } from 'fastify';
import { manifest } from './manifest';
import { catalogRoutes } from './routes';
import { dataJobRoutes } from './datajob-routes';
import { exportProductsHandler, importProductsHandler } from './datajobs';

export { manifest };
export { getProductRow, getVariantRow, toProductDto, toVariantDto, createProduct, createVariant, updateVariant, type ProductRow, type VariantRow } from './service';
export { evaluateReadiness } from './readiness';
export { jobEffects, requestEffects, type Effects } from './effects';
export type { ProductInput, VariantInput } from './service';

const routes: FastifyPluginAsync = async (app) => {
  await app.register(catalogRoutes);
  await app.register(dataJobRoutes); // own plugin: it registers a raw-body (text/csv) content-type parser
};

/**
 * Product Catalog: canonical products + variants/SKUs, search/filter/sort/pagination, bulk operations,
 * marketplace readiness, marketplace-specific data (kept outside the core model) and CSV import/export jobs.
 */
export const catalogModule = { manifest, routes, jobs: [importProductsHandler, exportProductsHandler] };
