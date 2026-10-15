import { manifest } from './manifest';
import { categoryRoutes } from './routes';

export { manifest };
export { categoryRoutes };
export { getCategory, toCategoryDto, type CategoryRow } from './service';

/** Categories: vendor-owned, marketplace-neutral category tree (materialised path). */
export const categoriesModule = { manifest, routes: categoryRoutes };
