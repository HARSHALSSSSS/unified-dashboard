import { and, eq, escapeLike, ilike, inArray, isNull, keyset, lt, or, schema, sql, writeAudit, writeOutboxEvent, type SQL, type Tx } from '@oms/database';
import { hashPassword, passwordPolicyViolations } from '@oms/auth';
import { AppError, Errors, normalizeEmail, notifySessionRevoked } from '@oms/shared';
import type { Container, MailMessage } from '@oms/module-kit';
import { newOpaqueToken, revokeSessions, sha256 } from '@oms/mod-identity';

type UserRow = typeof schema.users.$inferSelect;
type InvitationRow = typeof schema.invitations.$inferSelect;

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

async function roleMap(tx: Tx, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const rows = await tx
    .select({ userId: schema.userRoles.userId, key: schema.roles.key })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(inArray(schema.userRoles.userId, userIds));
  return new Map(rows.map((r) => [r.userId, r.key]));
}

export const toMember = (u: UserRow, roleKey: string | null) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  status: u.status as 'invited' | 'active' | 'disabled',
  roleKey,
  emailVerified: Boolean(u.emailVerifiedAt),
  lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  createdAt: u.createdAt.toISOString(),
});

// ------------------------------------------------------------------------------------------------
// members
// ------------------------------------------------------------------------------------------------
export interface MemberListInput { limit: number; cursor?: string; q?: string; status?: string; role?: string; sort?: Array<{ field: string; direction: 'asc' | 'desc' }> }

export async function listMembers(tx: Tx, vendorId: string, input: MemberListInput) {
  const u = schema.users;
  const ks = keyset<UserRow>({
    sorts: { createdAt: { column: u.createdAt, kind: 'timestamp' }, fullName: { column: u.fullName, kind: 'text' }, email: { column: u.email, kind: 'text' } },
    idColumn: u.id,
    sort: input.sort,
    defaultSort: { field: 'createdAt', direction: 'desc' },
    cursor: input.cursor,
    limit: input.limit,
  });
  const search: SQL | undefined = input.q ? or(ilike(u.fullName, `%${escapeLike(input.q)}%`), ilike(u.email, `%${escapeLike(input.q)}%`)) : undefined;
  const roleFilter: SQL | undefined = input.role
    ? sql`exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = "users"."id" and r.key = ${input.role})`
    : undefined;
  const field = input.sort?.[0]?.field ?? 'createdAt';
  const rows = await tx
    .select()
    .from(u)
    .where(and(eq(u.vendorId, vendorId), isNull(u.deletedAt), input.status ? eq(u.status, input.status) : undefined, search, roleFilter, ks.where))
    .orderBy(...ks.orderBy)
    .limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: field === 'fullName' ? r.fullName : field === 'email' ? r.email : r.createdAt, id: r.id }));
  const roles = await roleMap(tx, page.items.map((r) => r.id));
  return { items: page.items.map((r) => toMember(r, roles.get(r.id) ?? null)), nextCursor: page.nextCursor };
}

async function getUser(tx: Tx, vendorId: string, id: string): Promise<UserRow> {
  const [u] = await tx.select().from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.vendorId, vendorId), isNull(schema.users.deletedAt)));
  if (!u) throw Errors.notFound('User', id);
  return u;
}

export async function getMember(tx: Tx, vendorId: string, id: string) {
  const u = await getUser(tx, vendorId, id);
  return toMember(u, (await roleMap(tx, [u.id])).get(u.id) ?? null);
}

/** A vendor must always keep at least one active administrator. */
async function assertNotLastAdmin(tx: Tx, vendorId: string, excludingUserId: string): Promise<void> {
  const rows = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(and(eq(schema.users.vendorId, vendorId), eq(schema.users.status, 'active'), isNull(schema.users.deletedAt), eq(schema.roles.key, 'vendor_admin'), sql`${schema.users.id} <> ${excludingUserId}`))
    .limit(1);
  if (!rows.length) throw new AppError('CONFLICT', 'A vendor must keep at least one active administrator', { details: { rule: 'last_admin' } });
}

async function setRole(tx: Tx, vendorId: string, userId: string, roleKey: string): Promise<void> {
  const [role] = await tx.select().from(schema.roles).where(and(isNull(schema.roles.vendorId), eq(schema.roles.key, roleKey)));
  if (!role) throw Errors.notFound('Role', roleKey);
  await tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  await tx.insert(schema.userRoles).values({ userId, roleId: role.id, vendorId });
}

export async function updateMember(tx: Tx, vendorId: string, actorId: string, id: string, input: { roleKey?: string; status?: 'active' | 'disabled'; fullName?: string }) {
  const user = await getUser(tx, vendorId, id);
  const current = (await roleMap(tx, [id])).get(id) ?? null;
  const self = id === actorId;
  if (self && (input.roleKey !== undefined || input.status !== undefined)) {
    throw new AppError('CONFLICT', 'You cannot change your own role or status', { details: { rule: 'self_change' } });
  }
  if (current === 'vendor_admin' && ((input.roleKey && input.roleKey !== 'vendor_admin') || input.status === 'disabled')) {
    await assertNotLastAdmin(tx, vendorId, id);
  }
  const patch: Partial<typeof schema.users.$inferInsert> = {};
  if (input.fullName !== undefined) patch.fullName = input.fullName;
  if (input.status !== undefined) patch.status = input.status;
  if (Object.keys(patch).length) await tx.update(schema.users).set({ ...patch, version: sql`${schema.users.version} + 1` as never }).where(eq(schema.users.id, id));
  const roleChanged = input.roleKey !== undefined && input.roleKey !== current;
  if (roleChanged) await setRole(tx, vendorId, id, input.roleKey!);
  // a demotion must not keep working until the old access token expires: end every session (the user signs in again with the new role)
  if (roleChanged || (input.status === 'disabled' && user.status !== 'disabled')) (await revokeSessions(tx, { userId: id })).forEach(notifySessionRevoked);
  return { before: { roleKey: current, status: user.status, fullName: user.fullName }, after: await getMember(tx, vendorId, id) };
}

export async function removeMember(tx: Tx, vendorId: string, actorId: string, id: string) {
  const user = await getUser(tx, vendorId, id);
  if (id === actorId) throw new AppError('CONFLICT', 'You cannot remove yourself', { details: { rule: 'self_change' } });
  if (((await roleMap(tx, [id])).get(id) ?? null) === 'vendor_admin') await assertNotLastAdmin(tx, vendorId, id);
  await tx.update(schema.users).set({ status: 'disabled', deletedAt: new Date() }).where(eq(schema.users.id, id));
  (await revokeSessions(tx, { userId: id })).forEach(notifySessionRevoked);
  return user;
}

// ------------------------------------------------------------------------------------------------
// invitations
// ------------------------------------------------------------------------------------------------
export const toInvitation = (i: InvitationRow) => ({
  id: i.id,
  email: i.email,
  roleKey: i.roleKey,
  status: (i.status === 'pending' && i.expiresAt <= new Date() ? 'expired' : i.status) as 'pending' | 'accepted' | 'revoked' | 'expired',
  expiresAt: i.expiresAt.toISOString(),
  acceptedAt: i.acceptedAt ? i.acceptedAt.toISOString() : null,
  invitedBy: i.invitedBy,
  createdAt: i.createdAt.toISOString(),
});

function invitationMail(c: Container, to: string, token: string, vendorName: string, roleKey: string): MailMessage {
  const link = `${c.config.APP_WEB_URL.replace(/\/$/, '')}/accept-invitation?token=${encodeURIComponent(token)}`;
  return { kind: 'invitation', to, subject: `You have been invited to ${vendorName}`, text: `You were invited to join ${vendorName} as ${roleKey.replace('vendor_', '')}. Accept within 7 days:\n\n${link}`, data: { token, link } };
}

export async function createInvitation(tx: Tx, c: Container, vendorId: string, invitedBy: string, input: { email: string; roleKey: string }) {
  const email = normalizeEmail(input.email);
  const [existing] = await tx.select({ id: schema.users.id }).from(schema.users).where(and(sql`lower(${schema.users.email}) = ${email}`, isNull(schema.users.deletedAt)));
  if (existing) throw new AppError('CONFLICT', 'email already exists', { details: { field: 'email', reason: 'already_registered' } });

  // an expired pending invite must not block a fresh one (partial unique index is on status = 'pending')
  await tx.update(schema.invitations).set({ status: 'expired' }).where(and(eq(schema.invitations.vendorId, vendorId), sql`lower(${schema.invitations.email}) = ${email}`, eq(schema.invitations.status, 'pending'), lt(schema.invitations.expiresAt, new Date())));

  const token = newOpaqueToken();
  const [inv] = await tx
    .insert(schema.invitations)
    .values({ vendorId, email, roleKey: input.roleKey, tokenHash: sha256(token), invitedBy, expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
    .returning();
  const [vendor] = await tx.select({ name: schema.vendors.displayName }).from(schema.vendors).where(eq(schema.vendors.id, vendorId));
  await writeOutboxEvent(tx, { type: 'user.invited', vendorId, aggregateType: 'invitation', aggregateId: inv!.id, payload: { roleKey: input.roleKey } });
  return { invitation: inv!, mail: invitationMail(c, email, token, vendor?.name ?? 'your team', input.roleKey) };
}

export async function listInvitations(tx: Tx, vendorId: string, input: { limit: number; cursor?: string; status?: string }) {
  const i = schema.invitations;
  const ks = keyset<InvitationRow>({
    sorts: { createdAt: { column: i.createdAt, kind: 'timestamp' } },
    idColumn: i.id,
    defaultSort: { field: 'createdAt', direction: 'desc' },
    cursor: input.cursor,
    limit: input.limit,
  });
  const statusFilter: SQL | undefined =
    input.status === 'expired' ? and(eq(i.status, 'pending'), lt(i.expiresAt, new Date()))
    : input.status === 'pending' ? and(eq(i.status, 'pending'), sql`${i.expiresAt} > now()`)
    : input.status ? eq(i.status, input.status) : undefined;
  const rows = await tx.select().from(i).where(and(eq(i.vendorId, vendorId), statusFilter, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
  return { items: page.items.map(toInvitation), nextCursor: page.nextCursor };
}

async function getInvitation(tx: Tx, vendorId: string, id: string): Promise<InvitationRow> {
  const [i] = await tx.select().from(schema.invitations).where(and(eq(schema.invitations.id, id), eq(schema.invitations.vendorId, vendorId)));
  if (!i) throw Errors.notFound('Invitation', id);
  return i;
}

export async function revokeInvitation(tx: Tx, vendorId: string, id: string) {
  const inv = await getInvitation(tx, vendorId, id);
  if (inv.status !== 'pending') throw new AppError('CONFLICT', `Invitation is already ${inv.status}`);
  const [after] = await tx.update(schema.invitations).set({ status: 'revoked' }).where(eq(schema.invitations.id, id)).returning();
  return after!;
}

export async function resendInvitation(tx: Tx, c: Container, vendorId: string, id: string) {
  const inv = await getInvitation(tx, vendorId, id);
  if (inv.status !== 'pending') throw new AppError('CONFLICT', `Invitation is already ${inv.status}`);
  const token = newOpaqueToken();
  const [after] = await tx.update(schema.invitations).set({ tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) }).where(eq(schema.invitations.id, id)).returning();
  const [vendor] = await tx.select({ name: schema.vendors.displayName }).from(schema.vendors).where(eq(schema.vendors.id, vendorId));
  return { invitation: after!, mail: invitationMail(c, inv.email, token, vendor?.name ?? 'your team', inv.roleKey) };
}

/** Public: runs in system scope (the invitee has no account or token yet). */
export async function acceptInvitation(tx: Tx, input: { token: string; fullName: string; password: string }, meta: { requestId?: string; ip?: string; userAgent?: string }) {
  const problems = passwordPolicyViolations(input.password);
  if (problems.length) throw Errors.validation({ issues: [{ path: 'password', message: problems.join(', ') }] });

  const claimed = await tx
    .update(schema.invitations)
    .set({ status: 'accepted', acceptedAt: new Date() })
    .where(and(eq(schema.invitations.tokenHash, sha256(input.token)), eq(schema.invitations.status, 'pending'), sql`${schema.invitations.expiresAt} > now()`))
    .returning();
  const inv = claimed[0];
  if (!inv) throw new AppError('BAD_REQUEST', 'Invitation is invalid, expired or already used');

  const [existing] = await tx.select({ id: schema.users.id }).from(schema.users).where(and(sql`lower(${schema.users.email}) = ${inv.email}`, isNull(schema.users.deletedAt)));
  if (existing) throw new AppError('CONFLICT', 'email already exists', { details: { field: 'email' } });

  const [vendor] = await tx.select().from(schema.vendors).where(eq(schema.vendors.id, inv.vendorId));
  if (!vendor || vendor.status !== 'active') throw new AppError('TENANT_SUSPENDED');

  const [user] = await tx
    .insert(schema.users)
    .values({ vendorId: inv.vendorId, userType: 'vendor', email: inv.email, fullName: input.fullName, passwordHash: await hashPassword(input.password), status: 'active', emailVerifiedAt: new Date() })
    .returning();
  await setRole(tx, inv.vendorId, user!.id, inv.roleKey);
  await tx.update(schema.invitations).set({ acceptedUserId: user!.id }).where(eq(schema.invitations.id, inv.id));
  await writeOutboxEvent(tx, { type: 'user.created', vendorId: inv.vendorId, aggregateType: 'user', aggregateId: user!.id, payload: { role: inv.roleKey, via: 'invitation' } });
  await writeAudit(tx, { vendorId: inv.vendorId, actorType: 'user', actorId: user!.id, action: 'user.invitation_accepted', resourceType: 'invitation', resourceId: inv.id, requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, after: { email: inv.email, role: inv.roleKey } });
  return { user: toMember(user!, inv.roleKey), vendor: { id: vendor.id, displayName: vendor.displayName } };
}
