import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { MeSchema, successEnvelope } from '@oms/contracts';
import { ok } from '@oms/module-kit';
import { Errors } from '@oms/shared';

/** Reference route: shows the conventions every module route follows (schema, tags, access, envelope). */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get('/me', {
    config: { access: 'authenticated' },
    schema: {
      tags: ['Profile'],
      summary: 'Current principal',
      description: 'Returns the identity, tenant and effective permissions resolved from the access token.',
      response: { 200: successEnvelope(MeSchema) },
    },
  }, async (req) => {
    const p = req.ctx.principal;
    if (!p) throw Errors.unauthenticated();
    return ok(req, {
      userId: p.actorId,
      userType: p.userType,
      vendorId: req.ctx.scope?.kind === 'vendor' ? req.ctx.scope.vendorId : p.vendorId,
      roles: p.roles,
      permissions: [...p.permissions].sort(),
    });
  });
};
