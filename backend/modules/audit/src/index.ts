import { manifest } from './manifest';
import { auditRoutes } from './routes';

export { manifest };
export { auditRoutes };

/** Audit: read API over the append-only `audit_logs` table (writers use `audit()` from @oms/module-kit). */
export const auditModule = { manifest, routes: auditRoutes };
