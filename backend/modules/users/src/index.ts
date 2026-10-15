import { manifest } from './manifest';
import { userRoutes } from './routes';

export { manifest };
export { userRoutes };

/** User management: vendor members (roles, status), invitations and their acceptance. */
export const usersModule = { manifest, routes: userRoutes };
