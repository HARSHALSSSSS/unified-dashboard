import { manifest } from './manifest';
import { identityRoutes } from './routes';

export { manifest };
export { identityRoutes };
export { issueSession, toUserSummary, roleKeysOf, revokeSessions, sha256, newOpaqueToken, deliver, type ClientMeta, type UserRow } from './service';

/**
 * Identity & Access: authentication (register, login, refresh rotation, logout, e-mail verification,
 * password reset), profile, sessions and the role catalogue.
 *
 * Layout: schemas.ts (zod contracts) · service.ts (use-cases on a transaction) · routes.ts (Fastify plugin).
 * Other modules use the exported helpers (e.g. `issueSession` when an invitation is accepted).
 */
export const identityModule = { manifest, routes: identityRoutes };
