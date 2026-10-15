import { manifest } from './manifest';
import { platformAdminRoutes } from './routes';

export { manifest };
export { platformAdminRoutes } from './routes';

/**
 * Platform Admin: cross-tenant operations for platform staff (vendors, users, connector switches, feature flags, system health,
 * failed jobs / integrations). Separate permissions (`platform:*`) from every vendor role. Flag EVALUATION lives in @oms/database
 * (`isFeatureEnabled`) so any module can use it without depending on this one.
 */
export const platformAdminModule = { manifest, routes: platformAdminRoutes };
