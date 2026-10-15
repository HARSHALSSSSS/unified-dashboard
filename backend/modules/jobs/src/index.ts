import { manifest } from './manifest';

export { manifest };

/**
 * Public surface of the Jobs module.
 * Other modules may import ONLY from this entry point (enforced by ESLint + scripts/check-modules.ts).
 *
 * Layering inside the module (dependencies point downward only):
 *   http/            Fastify routes + zod schemas (OpenAPI source). Calls application services.
 *   application/     Use-cases / services. Transaction + tenant-context aware. Emits events via outbox.
 *   domain/          Entities, value objects, policies, state machines. Pure, no I/O.
 *   infrastructure/  Repositories (tenant-scoped), external clients.
 */
export const jobsModule = { manifest };
