import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { created, ok, requireScope, scopedTx, strictRateLimit, systemTx, audit } from '@oms/module-kit';
import { successEnvelope } from '@oms/contracts';
import { Errors } from '@oms/shared';
import * as svc from './service';
import {
  ChangePasswordBodySchema, ForgotBodySchema, LoginBodySchema, MessageSchema, RefreshBodySchema, RegisteredSchema, RegisterBodySchema,
  ResetBodySchema, RoleSchema, SessionSchema, SessionTokensSchema, TokenBodySchema, UpdateProfileBodySchema, UserSummarySchema, VendorSummarySchema,
} from './schemas';

const meta = (req: { id: string; ip: string; headers: Record<string, unknown> }): svc.ClientMeta => ({
  requestId: req.id,
  ip: req.ip,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
});

export const identityRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const strict = strictRateLimit(app, c.config.AUTH_RATE_LIMIT_MAX);
  const AUTH = { tags: ['Auth'] };

  // ------------------------------------------------------------------ registration
  r.post('/auth/register', {
    config: { access: 'public' },
    preHandler: strict,
    schema: {
      ...AUTH,
      summary: 'Register a vendor (business) and its first administrator',
      description: 'Creates the vendor (tenant), the first user with the Vendor Admin role and sends an e-mail verification link. The caller then signs in with POST /auth/login.',
      body: RegisterBodySchema,
      response: { 201: successEnvelope(RegisteredSchema) },
    },
  }, async (req, reply) => {
    const out = await systemTx(req, (tx) => svc.register(tx, c, req.body, meta(req)));
    await svc.deliver(c, out.mails);
    return created(req, reply, { user: out.user, vendor: out.vendor, emailVerificationRequired: c.config.EMAIL_VERIFICATION_REQUIRED });
  });

  // ------------------------------------------------------------------ login / refresh / logout
  r.post('/auth/login', {
    config: { access: 'public' },
    preHandler: strict,
    schema: {
      ...AUTH,
      summary: 'Sign in',
      description: 'Returns a short-lived access token (JWT) and a single-use refresh token. Repeated failures lock the account for 15 minutes.',
      body: LoginBodySchema,
      response: { 200: successEnvelope(SessionTokensSchema) },
    },
  }, async (req) => ok(req, await svc.login(c, (fn) => systemTx(req, fn), req.body, meta(req))));

  r.post('/auth/refresh', {
    config: { access: 'public' },
    preHandler: strict,
    schema: {
      ...AUTH,
      summary: 'Exchange a refresh token for a new token pair',
      description: 'Refresh tokens are rotated on every use. Presenting an already-used token revokes the whole session (theft detection).',
      body: RefreshBodySchema,
      response: { 200: successEnvelope(SessionTokensSchema) },
    },
  }, async (req) => ok(req, await svc.refresh(c, (fn) => systemTx(req, fn), req.body.refreshToken, meta(req))));

  r.post('/auth/logout', {
    config: { access: 'authenticated' },
    schema: { ...AUTH, summary: 'Sign out (end the current session)', response: { 200: successEnvelope(MessageSchema) } },
  }, async (req) => {
    const p = req.ctx.principal!;
    await systemTx(req, async (tx) => {
      if (p.sessionId) await svc.endSession(tx, p.actorId, p.sessionId);
      await audit(tx, req, { vendorId: p.vendorId, action: 'auth.logout', metadata: { sessionId: p.sessionId } });
    });
    return ok(req, { message: 'Signed out' });
  });

  r.post('/auth/logout-all', {
    config: { access: 'authenticated' },
    schema: { ...AUTH, summary: 'Sign out of every device', response: { 200: successEnvelope(z.object({ revokedSessions: z.number().int() })) } },
  }, async (req) => {
    const p = req.ctx.principal!;
    const revokedSessions = await systemTx(req, async (tx) => {
      const n = await svc.endAllSessions(tx, p.actorId);
      await audit(tx, req, { vendorId: p.vendorId, action: 'auth.logout_all' });
      return n;
    });
    return ok(req, { revokedSessions });
  });

  // ------------------------------------------------------------------ e-mail verification
  r.post('/auth/verify-email', {
    config: { access: 'public' },
    preHandler: strict,
    schema: { ...AUTH, summary: 'Verify an e-mail address', body: TokenBodySchema, response: { 200: successEnvelope(MessageSchema) } },
  }, async (req) => {
    await systemTx(req, (tx) => svc.verifyEmail(tx, req.body.token, meta(req)));
    return ok(req, { message: 'E-mail verified' });
  });

  r.post('/auth/resend-verification', {
    config: { access: 'authenticated' },
    preHandler: strict,
    schema: { ...AUTH, summary: 'Send a new verification e-mail', response: { 202: successEnvelope(MessageSchema) } },
  }, async (req, reply) => {
    const mails = await systemTx(req, (tx) => svc.resendVerification(tx, c, req.ctx.principal!.actorId));
    await svc.deliver(c, mails);
    reply.code(202);
    return ok(req, { message: 'If your address is not yet verified, a new link is on its way' });
  });

  // ------------------------------------------------------------------ password reset
  r.post('/auth/forgot-password', {
    config: { access: 'public' },
    preHandler: strict,
    schema: {
      ...AUTH,
      summary: 'Request a password-reset e-mail',
      description: 'Always answers 202, whether or not the address belongs to an account (no account enumeration).',
      body: ForgotBodySchema,
      response: { 202: successEnvelope(MessageSchema) },
    },
  }, async (req, reply) => {
    const mails = await systemTx(req, (tx) => svc.forgotPassword(tx, c, req.body.email, meta(req)));
    // e-mail delivery must not be on the response path: an existing account would otherwise answer measurably slower than an unknown one
    void svc.deliver(c, mails);
    reply.code(202);
    return ok(req, { message: 'If the address belongs to an account, a reset link is on its way' });
  });

  r.post('/auth/reset-password', {
    config: { access: 'public' },
    preHandler: strict,
    schema: {
      ...AUTH,
      summary: 'Set a new password using a reset token',
      description: 'Single-use token. Signs the user out of every device.',
      body: ResetBodySchema,
      response: { 200: successEnvelope(MessageSchema) },
    },
  }, async (req) => {
    await systemTx(req, (tx) => svc.resetPassword(tx, req.body.token, req.body.password, meta(req)));
    return ok(req, { message: 'Password updated. Sign in with your new password.' });
  });

  // ------------------------------------------------------------------ profile
  const PROFILE = { tags: ['Profile'] };
  const ProfileSchema = z.object({ user: UserSummarySchema, vendor: VendorSummarySchema.nullable() }).meta({ id: 'Profile' });

  r.get('/me/profile', {
    config: { access: 'authenticated' },
    schema: { ...PROFILE, summary: 'My profile', response: { 200: successEnvelope(ProfileSchema) } },
  }, async (req) => ok(req, await systemTx(req, (tx) => svc.getProfile(tx, req.ctx.principal!.actorId))));

  r.patch('/me/profile', {
    config: { access: 'authenticated' },
    schema: { ...PROFILE, summary: 'Update my profile', body: UpdateProfileBodySchema, response: { 200: successEnvelope(ProfileSchema) } },
  }, async (req) => ok(req, await systemTx(req, (tx) => svc.updateProfile(tx, req.ctx.principal!.actorId, req.body))));

  r.post('/me/change-password', {
    config: { access: 'authenticated' },
    preHandler: strict,
    schema: { ...PROFILE, summary: 'Change my password', description: 'Signs out every other session.', body: ChangePasswordBodySchema, response: { 200: successEnvelope(MessageSchema) } },
  }, async (req) => {
    const p = req.ctx.principal!;
    await systemTx(req, (tx) => svc.changePassword(tx, p.actorId, p.sessionId, req.body, meta(req)));
    return ok(req, { message: 'Password changed' });
  });

  r.get('/me/sessions', {
    config: { access: 'authenticated' },
    schema: { ...PROFILE, summary: 'My active sessions', response: { 200: successEnvelope(z.array(SessionSchema)) } },
  }, async (req) => {
    const p = req.ctx.principal!;
    return ok(req, await systemTx(req, (tx) => svc.listSessions(tx, p.actorId, p.sessionId)));
  });

  r.delete('/me/sessions/:id', {
    config: { access: 'authenticated' },
    schema: { ...PROFILE, summary: 'Revoke one of my sessions', params: z.object({ id: z.uuid() }), response: { 200: successEnvelope(MessageSchema) } },
  }, async (req) => {
    const p = req.ctx.principal!;
    const found = await systemTx(req, (tx) => svc.endSession(tx, p.actorId, req.params.id));
    if (!found) throw Errors.notFound('Session', req.params.id);
    return ok(req, { message: 'Session revoked' });
  });

  // ------------------------------------------------------------------ roles catalogue
  r.get('/roles', {
    config: { access: { permission: 'roles:read' } },
    schema: {
      tags: ['Roles'],
      summary: 'List roles and their permissions',
      description: 'System roles assignable to members: Vendor Admin, Vendor Staff, Vendor Viewer (platform staff also see platform roles).',
      response: { 200: successEnvelope(z.array(RoleSchema)) },
    },
  }, async (req) => {
    const scope = requireScope(req);
    return ok(req, await scopedTx(req, (tx) => svc.listRoles(tx, scope.kind === 'platform')));
  });
};
