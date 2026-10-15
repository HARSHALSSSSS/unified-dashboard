import { createHash, randomBytes } from 'node:crypto';
import {
  generateRefreshToken, hashPassword, hashRefreshToken, passwordPolicyViolations, signAccessToken, verifyDummy, verifyPassword,
} from '@oms/auth';
import { and, eq, gt, inArray, isNull, ne, schema, sql, writeAudit, writeOutboxEvent, type Tx } from '@oms/database';
import { AppError, Errors, newId, normalizeEmail, notifySessionRevoked, slugify } from '@oms/shared';
import type { Container, MailMessage } from '@oms/module-kit';

/**
 * Identity service: pure application logic on top of a transaction. HTTP concerns live in routes.ts.
 * Email delivery is returned as `MailMessage[]` for the caller to send AFTER the transaction commits
 * (so a rollback can never leave an e-mailed token that does not exist).
 */
export interface ClientMeta { ip?: string; userAgent?: string; requestId?: string }

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const VERIFY_TTL_MS = 48 * 3600 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export type UserRow = typeof schema.users.$inferSelect;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');

export async function roleKeysOf(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ key: schema.roles.key })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(eq(schema.userRoles.userId, userId));
  return rows.map((r) => r.key);
}

export async function toUserSummary(tx: Tx, u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    userType: u.userType as 'vendor' | 'platform',
    vendorId: u.vendorId,
    roles: await roleKeysOf(tx, u.id),
    emailVerified: Boolean(u.emailVerifiedAt),
    status: u.status,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  };
}

async function vendorOf(tx: Tx, vendorId: string | null) {
  if (!vendorId) return null;
  const [v] = await tx.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId));
  return v ? { id: v.id, displayName: v.displayName, slug: v.slug, status: v.status } : null;
}

// ------------------------------------------------------------------------------------------------
// sessions & tokens
// ------------------------------------------------------------------------------------------------
export function tokenConfig(c: Container) {
  const { config } = c;
  return { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, secret: config.JWT_ACCESS_SECRET, accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS };
}

/** Issue an access + refresh token pair. A new session = a new refresh-token family (familyId == JWT `sid`). */
export async function issueSession(tx: Tx, c: Container, user: UserRow, meta: ClientMeta, familyId: string = newId()) {
  const roles = await roleKeysOf(tx, user.id);
  const refresh = generateRefreshToken();
  await tx.insert(schema.refreshTokens).values({
    userId: user.id,
    vendorId: user.vendorId,
    familyId,
    tokenHash: refresh.hash,
    expiresAt: new Date(Date.now() + c.config.REFRESH_TOKEN_TTL_SECONDS * 1000),
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ip: meta.ip ?? null,
  });
  const access = await signAccessToken(tokenConfig(c), { sub: user.id, vid: user.vendorId, utp: user.userType as 'vendor' | 'platform', rol: roles, sid: familyId });
  return {
    tokenType: 'Bearer' as const,
    accessToken: access.token,
    expiresIn: access.expiresIn,
    refreshToken: refresh.token,
    sessionId: familyId,
    user: await toUserSummary(tx, user),
    vendor: await vendorOf(tx, user.vendorId),
  };
}

async function revokeFamilies(tx: Tx, where: ReturnType<typeof and>): Promise<string[]> {
  const rows = await tx
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(isNull(schema.refreshTokens.revokedAt), where))
    .returning({ familyId: schema.refreshTokens.familyId });
  const families = [...new Set(rows.map((r) => r.familyId))];
  return families;
}

/** Revoke sessions (optionally one, optionally sparing one). Returns the revoked session ids; callers notify caches. */
export async function revokeSessions(tx: Tx, opts: { userId: string; sessionId?: string; exceptSessionId?: string }): Promise<string[]> {
  const conds = [eq(schema.refreshTokens.userId, opts.userId)];
  if (opts.sessionId) conds.push(eq(schema.refreshTokens.familyId, opts.sessionId));
  if (opts.exceptSessionId) conds.push(ne(schema.refreshTokens.familyId, opts.exceptSessionId));
  return revokeFamilies(tx, and(...conds));
}

// ------------------------------------------------------------------------------------------------
// one-time e-mail tokens
// ------------------------------------------------------------------------------------------------
async function createUserToken(tx: Tx, userId: string, purpose: 'email_verification' | 'password_reset', ttlMs: number): Promise<string> {
  await tx.update(schema.userTokens).set({ usedAt: new Date() }).where(and(eq(schema.userTokens.userId, userId), eq(schema.userTokens.purpose, purpose), isNull(schema.userTokens.usedAt)));
  const token = newOpaqueToken();
  await tx.insert(schema.userTokens).values({ userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
}

/** Atomically consume a token (single use). Returns the user id or null. */
async function consumeUserToken(tx: Tx, token: string, purpose: 'email_verification' | 'password_reset'): Promise<string | null> {
  const rows = await tx
    .update(schema.userTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.userTokens.tokenHash, sha256(token)), eq(schema.userTokens.purpose, purpose), isNull(schema.userTokens.usedAt), gt(schema.userTokens.expiresAt, new Date())))
    .returning({ userId: schema.userTokens.userId });
  return rows[0]?.userId ?? null;
}

function mail(c: Container, kind: MailMessage['kind'], to: string, token: string, path: string, subject: string, text: string): MailMessage {
  const link = `${c.config.APP_WEB_URL.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;
  return { kind, to, subject, text: `${text}\n\n${link}`, data: { token, link } };
}
export const verifyEmailMail = (c: Container, to: string, token: string) =>
  mail(c, 'verify_email', to, token, '/verify-email', 'Verify your e-mail address', 'Confirm your e-mail address to unlock inviting teammates and connecting marketplaces. This link expires in 48 hours.');
export const resetPasswordMail = (c: Container, to: string, token: string) =>
  mail(c, 'reset_password', to, token, '/reset-password', 'Reset your password', 'Use the link below to choose a new password. It expires in 1 hour. If you did not request this, ignore this e-mail.');

/** Deliver mails after commit; delivery failures are logged, never surfaced (they must not leak account existence). */
export async function deliver(c: Container, mails: MailMessage[]): Promise<void> {
  for (const m of mails) {
    try { await c.mailer.send(m); } catch (err) { c.logger.error({ err, kind: m.kind }, 'mail delivery failed'); }
  }
}

// ------------------------------------------------------------------------------------------------
// registration
// ------------------------------------------------------------------------------------------------
export interface RegisterInput { businessName: string; legalName?: string; fullName: string; email: string; password: string; phone?: string; gstin?: string }

export async function register(tx: Tx, c: Container, input: RegisterInput, meta: ClientMeta) {
  const problems = passwordPolicyViolations(input.password);
  if (problems.length) throw Errors.validation({ issues: [{ path: 'password', message: problems.join(', ') }] });
  const email = normalizeEmail(input.email);

  const [dup] = await tx.select({ id: schema.users.id }).from(schema.users).where(and(sql`lower(${schema.users.email}) = ${email}`, isNull(schema.users.deletedAt)));
  if (dup) throw new AppError('CONFLICT', 'email already exists', { details: { field: 'email' } });

  let slug = slugify(input.businessName, 40);
  for (let i = 0; i < 6; i++) {
    const [taken] = await tx.select({ id: schema.vendors.id }).from(schema.vendors).where(and(eq(schema.vendors.slug, slug), isNull(schema.vendors.deletedAt)));
    if (!taken) break;
    slug = `${slugify(input.businessName, 34)}-${randomBytes(2).toString('hex')}`;
  }

  const [vendor] = await tx
    .insert(schema.vendors)
    .values({ slug, legalName: input.legalName ?? input.businessName, displayName: input.businessName, status: 'active', businessEmail: email, phone: input.phone ?? null, gstin: input.gstin ?? null })
    .returning();
  const passwordHash = await hashPassword(input.password);
  const [user] = await tx
    .insert(schema.users)
    .values({ vendorId: vendor!.id, userType: 'vendor', email, passwordHash, fullName: input.fullName, status: 'active' })
    .returning();

  const [role] = await tx.select().from(schema.roles).where(and(isNull(schema.roles.vendorId), eq(schema.roles.key, 'vendor_admin')));
  if (!role) throw new AppError('INTERNAL', 'System roles are not seeded (run db:seed)');
  await tx.insert(schema.userRoles).values({ userId: user!.id, roleId: role.id, vendorId: vendor!.id });

  const token = await createUserToken(tx, user!.id, 'email_verification', VERIFY_TTL_MS);

  await writeOutboxEvent(tx, { type: 'vendor.created', vendorId: vendor!.id, aggregateType: 'vendor', aggregateId: vendor!.id, payload: { slug, displayName: vendor!.displayName } });
  await writeOutboxEvent(tx, { type: 'user.created', vendorId: vendor!.id, aggregateType: 'user', aggregateId: user!.id, payload: { role: 'vendor_admin' } });
  await writeAudit(tx, { vendorId: vendor!.id, actorType: 'user', actorId: user!.id, action: 'auth.register', resourceType: 'vendor', resourceId: vendor!.id, requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, after: { slug, email } });

  return {
    user: await toUserSummary(tx, user!),
    vendor: { id: vendor!.id, displayName: vendor!.displayName, slug: vendor!.slug, status: vendor!.status },
    mails: [verifyEmailMail(c, email, token)],
  };
}

// ------------------------------------------------------------------------------------------------
// login / refresh / logout
// ------------------------------------------------------------------------------------------------
type LoginLookup = { kind: 'ok'; user: UserRow } | { kind: 'fail'; user: UserRow | null; locked: boolean };

export async function login(c: Container, systemTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, input: { email: string; password: string }, meta: ClientMeta) {
  const email = normalizeEmail(input.email);

  const lookup: LoginLookup = await systemTx(async (tx) => {
    const [u] = await tx.select().from(schema.users).where(and(sql`lower(${schema.users.email}) = ${email}`, isNull(schema.users.deletedAt)));
    if (!u || !u.passwordHash || u.status !== 'active') return { kind: 'fail', user: null, locked: false } as const;
    if (u.lockedUntil && u.lockedUntil > new Date()) return { kind: 'fail', user: u, locked: true } as const;
    return { kind: 'ok', user: u } as const;
  });

  if (lookup.kind === 'fail') {
    await verifyDummy(input.password); // equalise timing: unknown user vs wrong password
    await systemTx((tx) => writeAudit(tx, { vendorId: lookup.user?.vendorId ?? null, actorType: 'user', actorId: lookup.user?.id ?? null, action: lookup.locked ? 'auth.login_locked' : 'auth.login_failed', requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, metadata: { email } }));
    // a locked account answers exactly like a wrong password: the response must not reveal that the address has an account
    throw new AppError('INVALID_CREDENTIALS');
  }

  const valid = await verifyPassword(lookup.user.passwordHash!, input.password);
  if (!valid) {
    await systemTx(async (tx) => {
      // ONE atomic statement: parallel guesses cannot all read the same counter and dodge the lock
      const U = schema.users;
      const [row] = await tx.update(U).set({
        failedLoginCount: sql`CASE WHEN ${U.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} THEN 0 ELSE ${U.failedLoginCount} + 1 END`,
        lockedUntil: sql`CASE WHEN ${U.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} THEN now() + (${LOCK_MINUTES} * interval '1 minute') ELSE ${U.lockedUntil} END`,
      }).where(eq(U.id, lookup.user.id)).returning({ lockedUntil: U.lockedUntil });
      const lock = Boolean(row?.lockedUntil && row.lockedUntil > new Date());
      await writeAudit(tx, { vendorId: lookup.user.vendorId, actorType: 'user', actorId: lookup.user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, metadata: { email } });
    });
    throw new AppError('INVALID_CREDENTIALS');
  }

  return systemTx(async (tx) => {
    if (lookup.user.vendorId) {
      const v = await vendorOf(tx, lookup.user.vendorId);
      if (!v || v.status !== 'active') throw new AppError('TENANT_SUSPENDED');
    }
    await tx.update(schema.users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(schema.users.id, lookup.user.id));
    const session = await issueSession(tx, c, { ...lookup.user, lastLoginAt: new Date() }, meta);
    await writeAudit(tx, { vendorId: lookup.user.vendorId, actorType: 'user', actorId: lookup.user.id, action: 'auth.login', requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, metadata: { sessionId: session.sessionId } });
    return session;
  });
}

export async function refresh(c: Container, systemTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, refreshToken: string, meta: ClientMeta) {
  const outcome = await systemTx(async (tx) => {
    const [row] = await tx.select().from(schema.refreshTokens).where(eq(schema.refreshTokens.tokenHash, hashRefreshToken(refreshToken)));
    if (!row) return { error: 'invalid' as const };

    // Atomic single-use claim. Failing to claim a token that exists = it was already used or revoked = REUSE.
    const claimed = await tx
      .update(schema.refreshTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(schema.refreshTokens.id, row.id), isNull(schema.refreshTokens.usedAt), isNull(schema.refreshTokens.revokedAt), gt(schema.refreshTokens.expiresAt, new Date())))
      .returning({ id: schema.refreshTokens.id });
    if (!claimed.length) {
      if (row.expiresAt <= new Date() && !row.usedAt && !row.revokedAt) return { error: 'expired' as const };
      // Reuse of a rotated/revoked token: assume theft, kill the whole session family.
      const revoked = await revokeFamilies(tx, eq(schema.refreshTokens.familyId, row.familyId));
      await writeAudit(tx, { vendorId: row.vendorId, actorType: 'user', actorId: row.userId, action: 'auth.refresh_reuse_detected', requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, metadata: { sessionId: row.familyId } });
      return { error: 'reuse' as const, revoked: revoked.length ? revoked : [row.familyId] };
    }

    const [user] = await tx.select().from(schema.users).where(and(eq(schema.users.id, row.userId), isNull(schema.users.deletedAt)));
    const vendor = user ? await vendorOf(tx, user.vendorId) : null;
    if (!user || user.status !== 'active' || (user.vendorId && vendor?.status !== 'active')) {
      const revoked = await revokeFamilies(tx, eq(schema.refreshTokens.familyId, row.familyId));
      return { error: 'inactive' as const, revoked };
    }
    return { session: await issueSession(tx, c, user, meta, row.familyId) };
  });

  if ('error' in outcome) {
    for (const sid of outcome.error === 'reuse' || outcome.error === 'inactive' ? outcome.revoked : []) notifySessionRevoked(sid);
    throw new AppError('TOKEN_INVALID', 'Refresh token is invalid, expired or already used');
  }
  return outcome.session;
}

export async function endSession(tx: Tx, userId: string, sessionId: string): Promise<boolean> {
  const revoked = await revokeSessions(tx, { userId, sessionId });
  revoked.forEach(notifySessionRevoked);
  return revoked.length > 0;
}

export async function endAllSessions(tx: Tx, userId: string, exceptSessionId?: string): Promise<number> {
  const revoked = await revokeSessions(tx, { userId, exceptSessionId });
  revoked.forEach(notifySessionRevoked);
  return revoked.length;
}

export async function listSessions(tx: Tx, userId: string, currentSessionId?: string) {
  const res = await tx.execute<{ family_id: string; started_at: Date | string; last_active_at: Date | string; ua: string | null; ip: string | null }>(sql`
    select family_id, min(created_at) as started_at, max(created_at) as last_active_at,
           (array_agg(user_agent order by created_at desc))[1] as ua, (array_agg(ip order by created_at desc))[1] as ip
    from refresh_tokens
    where user_id = ${userId} and revoked_at is null
    group by family_id
    having bool_or(used_at is null and expires_at > now())
    order by max(created_at) desc`);
  return res.rows.map((r) => ({
    id: r.family_id,
    current: r.family_id === currentSessionId,
    startedAt: new Date(r.started_at).toISOString(),
    lastActiveAt: new Date(r.last_active_at).toISOString(),
    userAgent: r.ua,
    ip: r.ip,
  }));
}

// ------------------------------------------------------------------------------------------------
// e-mail verification / password reset / password change / profile
// ------------------------------------------------------------------------------------------------
export async function verifyEmail(tx: Tx, token: string, meta: ClientMeta): Promise<void> {
  const userId = await consumeUserToken(tx, token, 'email_verification');
  if (!userId) throw new AppError('BAD_REQUEST', 'Verification link is invalid or has expired');
  const [u] = await tx.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, userId)).returning();
  await writeAudit(tx, { vendorId: u?.vendorId ?? null, actorType: 'user', actorId: userId, action: 'auth.email_verified', requestId: meta.requestId, ip: meta.ip });
}

export async function resendVerification(tx: Tx, c: Container, userId: string): Promise<MailMessage[]> {
  const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u || u.emailVerifiedAt) return [];
  return [verifyEmailMail(c, u.email, await createUserToken(tx, u.id, 'email_verification', VERIFY_TTL_MS))];
}

/** Always succeeds from the caller's point of view (no account enumeration); returns mails to send for real accounts. */
export async function forgotPassword(tx: Tx, c: Container, emailRaw: string, meta: ClientMeta): Promise<MailMessage[]> {
  const email = normalizeEmail(emailRaw);
  const [u] = await tx.select().from(schema.users).where(and(sql`lower(${schema.users.email}) = ${email}`, isNull(schema.users.deletedAt)));
  if (!u || u.status !== 'active') return [];
  const token = await createUserToken(tx, u.id, 'password_reset', RESET_TTL_MS);
  await writeAudit(tx, { vendorId: u.vendorId, actorType: 'user', actorId: u.id, action: 'auth.password_reset_requested', requestId: meta.requestId, ip: meta.ip });
  return [resetPasswordMail(c, u.email, token)];
}

export async function resetPassword(tx: Tx, token: string, newPassword: string, meta: ClientMeta): Promise<void> {
  const problems = passwordPolicyViolations(newPassword);
  if (problems.length) throw Errors.validation({ issues: [{ path: 'password', message: problems.join(', ') }] });
  const userId = await consumeUserToken(tx, token, 'password_reset');
  if (!userId) throw new AppError('BAD_REQUEST', 'Reset link is invalid or has expired');
  const [u] = await tx
    .update(schema.users)
    .set({ passwordHash: await hashPassword(newPassword), failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: sql`coalesce(${schema.users.emailVerifiedAt}, now())` })
    .where(eq(schema.users.id, userId))
    .returning();
  (await revokeSessions(tx, { userId })).forEach(notifySessionRevoked); // every device must sign in again
  await writeAudit(tx, { vendorId: u?.vendorId ?? null, actorType: 'user', actorId: userId, action: 'auth.password_reset', requestId: meta.requestId, ip: meta.ip });
}

export async function changePassword(tx: Tx, userId: string, sessionId: string | undefined, input: { currentPassword: string; newPassword: string }, meta: ClientMeta): Promise<void> {
  const problems = passwordPolicyViolations(input.newPassword);
  if (problems.length) throw Errors.validation({ issues: [{ path: 'newPassword', message: problems.join(', ') }] });
  const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u?.passwordHash || !(await verifyPassword(u.passwordHash, input.currentPassword))) throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
  await tx.update(schema.users).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(schema.users.id, userId));
  (await revokeSessions(tx, { userId, exceptSessionId: sessionId })).forEach(notifySessionRevoked);
  await writeAudit(tx, { vendorId: u.vendorId, actorType: 'user', actorId: userId, action: 'auth.password_changed', requestId: meta.requestId, ip: meta.ip });
}

export async function getProfile(tx: Tx, userId: string) {
  const [u] = await tx.select().from(schema.users).where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));
  if (!u) throw Errors.notFound('User', userId);
  return { user: await toUserSummary(tx, u), vendor: await vendorOf(tx, u.vendorId) };
}

export async function updateProfile(tx: Tx, userId: string, input: { fullName: string }) {
  await tx.update(schema.users).set({ fullName: input.fullName, version: sql`${schema.users.version} + 1` }).where(eq(schema.users.id, userId));
  return getProfile(tx, userId);
}

/** Role catalogue visible to API clients (system roles only; vendors cannot see platform roles). */
export async function listRoles(tx: Tx, includePlatform: boolean) {
  const roles = await tx.select().from(schema.roles).where(isNull(schema.roles.vendorId));
  const visible = roles.filter((r) => includePlatform || r.key.startsWith('vendor_'));
  const grants = visible.length
    ? await tx.select().from(schema.rolePermissions).where(inArray(schema.rolePermissions.roleId, visible.map((r) => r.id)))
    : [];
  return visible.map((r) => ({
    key: r.key,
    name: r.name,
    userType: (r.key.startsWith('platform_') ? 'platform' : 'vendor') as 'vendor' | 'platform',
    permissions: grants.filter((g) => g.roleId === r.id).map((g) => g.permissionKey).sort(),
  }));
}
