import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertEmailVerified, audit, created, emit, ok, paginated, strictRateLimit, systemTx, vendorTx } from '@oms/module-kit';
import { IdParamSchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { deliver } from '@oms/mod-identity';
import * as svc from './service';
import { AcceptedSchema, AcceptInvitationBodySchema, InvitationListQuerySchema, InvitationSchema, InviteBodySchema, MemberListQuerySchema, MemberSchema, UpdateMemberBodySchema } from './schemas';

export const userRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const strict = strictRateLimit(app, c.config.AUTH_RATE_LIMIT_MAX);
  const USERS = ['Users'];
  const INV = ['Invitations'];
  const MessageSchema = z.object({ message: z.string() });

  // ------------------------------------------------------------------ members
  r.get('/users', {
    config: { access: { permission: 'users:read' } },
    schema: {
      tags: USERS,
      summary: 'List the members of my vendor',
      description: 'Search (`q`: name/e-mail), `filter[status]`, `filter[role]`, `sort` (createdAt, fullName, email), keyset pagination.',
      querystring: MemberListQuerySchema,
      response: { 200: paginatedEnvelope(MemberSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listMembers(tx, vendorId, { limit: q.limit, cursor: q.cursor, q: q.q, status: q['filter[status]'], role: q['filter[role]'], sort: q.sort }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/users/:id', {
    config: { access: { permission: 'users:read' } },
    schema: { tags: USERS, summary: 'Get a member', params: IdParamSchema, response: { 200: successEnvelope(MemberSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.getMember(tx, vendorId, req.params.id))));

  r.patch('/users/:id', {
    config: { access: { permission: 'users:write' } },
    schema: {
      tags: USERS,
      summary: 'Change a member\'s role, status or name',
      description: 'Members cannot change their own role/status, and a vendor always keeps at least one active Vendor Admin. Disabling a member signs them out everywhere.',
      params: IdParamSchema,
      body: UpdateMemberBodySchema,
      response: { 200: successEnvelope(MemberSchema) },
    },
  }, async (req) => {
    const out = await vendorTx(req, async (tx, vendorId) => {
      const res = await svc.updateMember(tx, vendorId, req.ctx.principal!.actorId, req.params.id, req.body);
      await audit(tx, req, { action: 'user.update', resourceType: 'user', resourceId: req.params.id, before: res.before, after: { roleKey: res.after.roleKey, status: res.after.status, fullName: res.after.fullName } });
      await emit(tx, req, { type: 'user.updated', aggregateType: 'user', aggregateId: req.params.id, payload: { fields: Object.keys(req.body) } });
      return res.after;
    });
    return ok(req, out);
  });

  r.delete('/users/:id', {
    config: { access: { permission: 'users:write' } },
    schema: { tags: USERS, summary: 'Remove a member from my vendor', description: 'Soft-deletes the user and ends all of their sessions.', params: IdParamSchema, response: { 200: successEnvelope(MessageSchema) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => {
      const u = await svc.removeMember(tx, vendorId, req.ctx.principal!.actorId, req.params.id);
      await audit(tx, req, { action: 'user.remove', resourceType: 'user', resourceId: u.id, before: { email: u.email } });
      await emit(tx, req, { type: 'user.deactivated', aggregateType: 'user', aggregateId: u.id, payload: {} });
    });
    return ok(req, { message: 'Member removed' });
  });

  // ------------------------------------------------------------------ invitations
  r.post('/invitations', {
    config: { access: { permission: 'users:write' } },
    schema: {
      tags: INV,
      summary: 'Invite someone to my vendor',
      description: 'Sends an e-mail with a single-use link valid for 7 days. Requires a verified e-mail address on the inviting account. Roles: vendor_admin, vendor_staff, vendor_viewer.',
      body: InviteBodySchema,
      response: { 201: successEnvelope(InvitationSchema) },
    },
  }, async (req, reply) => {
    const out = await vendorTx(req, async (tx, vendorId) => {
      await assertEmailVerified(req, tx);
      const res = await svc.createInvitation(tx, c, vendorId, req.ctx.principal!.actorId, req.body);
      await audit(tx, req, { action: 'invitation.create', resourceType: 'invitation', resourceId: res.invitation.id, after: { email: res.invitation.email, roleKey: res.invitation.roleKey } });
      return res;
    });
    await deliver(c, [out.mail]);
    return created(req, reply, svc.toInvitation(out.invitation));
  });

  r.get('/invitations', {
    config: { access: { permission: 'users:read' } },
    schema: { tags: INV, summary: 'List invitations', querystring: InvitationListQuerySchema, response: { 200: paginatedEnvelope(InvitationSchema) } },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listInvitations(tx, vendorId, { limit: q.limit, cursor: q.cursor, status: q['filter[status]'] }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.post('/invitations/:id/resend', {
    config: { access: { permission: 'users:write' } },
    schema: { tags: INV, summary: 'Resend an invitation (new link, new 7-day window)', params: IdParamSchema, response: { 200: successEnvelope(InvitationSchema) } },
  }, async (req) => {
    const out = await vendorTx(req, async (tx, vendorId) => {
      await assertEmailVerified(req, tx);
      const res = await svc.resendInvitation(tx, c, vendorId, req.params.id);
      await audit(tx, req, { action: 'invitation.resend', resourceType: 'invitation', resourceId: req.params.id });
      return res;
    });
    await deliver(c, [out.mail]);
    return ok(req, svc.toInvitation(out.invitation));
  });

  r.delete('/invitations/:id', {
    config: { access: { permission: 'users:write' } },
    schema: { tags: INV, summary: 'Revoke a pending invitation', params: IdParamSchema, response: { 200: successEnvelope(InvitationSchema) } },
  }, async (req) => {
    const inv = await vendorTx(req, async (tx, vendorId) => {
      const res = await svc.revokeInvitation(tx, vendorId, req.params.id);
      await audit(tx, req, { action: 'invitation.revoke', resourceType: 'invitation', resourceId: req.params.id });
      return res;
    });
    return ok(req, svc.toInvitation(inv));
  });

  r.post('/invitations/accept', {
    config: { access: 'public' },
    preHandler: strict,
    schema: {
      tags: INV,
      summary: 'Accept an invitation and create my account',
      description: 'Public endpoint used by the link in the invitation e-mail. The e-mail address is taken from the invitation (and counts as verified). Sign in afterwards with POST /auth/login.',
      body: AcceptInvitationBodySchema,
      response: { 201: successEnvelope(AcceptedSchema) },
    },
  }, async (req, reply) => {
    const out = await systemTx(req, (tx) => svc.acceptInvitation(tx, req.body, { requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'] }));
    return created(req, reply, out);
  });
};
