import fp from 'fastify-plugin';
import { isWritePermission, verifyAccessToken, principalFromClaims, type TokenConfig } from '@oms/auth';
import { enrichContext } from '@oms/logging';
import { AppError, Errors, isUuid, resolveScope } from '@oms/shared';
import type { AccessDirectory } from '../access-directory';

/**
 * Authentication + authorisation + tenant resolution, in ONE hook that runs on every request:
 *
 *  1. route must declare config.access (guaranteed at boot by route-policy; missing => deny)
 *  2. 'public' / 'internal' routes skip auth
 *  3. verify Bearer JWT  (signature, issuer, audience, expiry, pinned alg)
 *  4. resolve permissions from role keys (cached directory)
 *  5. vendor users: the vendor must be ACTIVE (suspension takes effect immediately)
 *  6. platform staff may act inside a vendor only with `platform:impersonate` + X-Act-As-Vendor header
 *  7. RBAC: route permission must be in the principal's permission set
 *  8. request.ctx.scope is the ONLY source of the tenant id downstream. Body/query/path vendor ids are never trusted.
 */
export const accessPlugin = fp<{ tokens: TokenConfig; directory: AccessDirectory }>(async (app, opts) => {
  app.addHook('onRequest', async (req) => {
    if (req.is404) return;
    const access = req.routeOptions.config?.access;
    if (!access) {
      // Only Swagger UI static assets (hidden, under /docs) may lack a policy; everything else is deny-by-default.
      const r = req.routeOptions;
      if (r.url?.startsWith('/docs') && (r.schema as { hide?: boolean } | undefined)?.hide) return;
      throw Errors.forbidden();
    }
    if (access === 'public' || access === 'internal') return;

    const header = req.headers.authorization;
    if (!header?.toLowerCase().startsWith('bearer ')) throw Errors.unauthenticated('Missing bearer token');
    const claims = await verifyAccessToken(opts.tokens, header.slice(7).trim());

    if (opts.directory.sessionActive && !(await opts.directory.sessionActive(claims.sid))) throw new AppError('TOKEN_INVALID', 'Session has ended');
    const permissions = await opts.directory.permissionsFor(claims.rol, claims.vid);
    const principal = principalFromClaims(claims, permissions);

    if (principal.userType === 'vendor') {
      if (!principal.vendorId) throw new AppError('TOKEN_INVALID');
      if ((await opts.directory.vendorStatus(principal.vendorId)) !== 'active') throw new AppError('TENANT_SUSPENDED');
    }

    const actAs = req.headers['x-act-as-vendor'];
    if (actAs !== undefined) {
      if (principal.userType !== 'platform' || !permissions.has('platform:impersonate')) throw Errors.forbidden('platform:impersonate');
      if (typeof actAs !== 'string' || !isUuid(actAs)) throw new AppError('BAD_REQUEST', 'X-Act-As-Vendor must be a vendor UUID');
      if (!(await opts.directory.vendorStatus(actAs))) throw Errors.notFound('Vendor', actAs);
      // Acting inside a tenant is READ-ONLY for everyone (support and admins alike): a stolen platform token must not be able to
      // change tenant data. Anything that could mutate (any non-GET/HEAD method, or a write permission) is refused.
      const readOnly = req.method === 'GET' || req.method === 'HEAD';
      if (!readOnly || (typeof access === 'object' && isWritePermission(access.permission))) throw new AppError('FORBIDDEN', 'Acting on behalf of a vendor is read-only', { details: { rule: 'impersonation_read_only' } });
      principal.actingAsVendorId = actAs;
      req.log.warn({ actorId: principal.actorId, onBehalfOfVendorId: actAs, route: req.routeOptions.url }, 'platform.cross_tenant_access');
    }

    const scope = resolveScope(principal);
    req.ctx.principal = principal;
    req.ctx.scope = scope;
    enrichContext({ actorId: principal.actorId, vendorId: scope?.kind === 'vendor' ? scope.vendorId : null });

    if (typeof access === 'object') {
      if (!permissions.has(access.permission)) throw Errors.forbidden(access.permission);
      // Tenant-data routes need a vendor scope unless the caller is platform staff reading cross-tenant.
      if (!scope) throw Errors.forbidden();
    }
  });
}, { name: 'oms-access' });
