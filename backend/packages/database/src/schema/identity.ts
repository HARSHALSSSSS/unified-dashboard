import { sql } from 'drizzle-orm';
import { boolean, char, check, index, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, inList, pk, timestamps, tz, version } from './_helpers';

export const VENDOR_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;

/** Tenant root. Not itself tenant-filtered by vendor_id (its own id IS the tenant id). */
export const vendors = pgTable('vendors', {
  id: pk(),
  slug: text('slug').notNull(),
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('pending'),
  plan: text('plan').notNull().default('free'),
  /** business profile */
  businessEmail: text('business_email'),
  phone: text('phone'),
  gstin: text('gstin'),
  pan: text('pan'),
  address: jsonb('address').$type<Record<string, unknown>>().notNull().default({}),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  logoKey: text('logo_key'),
  /** why the platform changed the status (suspension reason etc.) */
  statusReason: text('status_reason'),
  statusChangedAt: tz('status_changed_at'),
  /** business settings (validated by the vendors module) */
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  version: version(),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  uniqueIndex('vendors_slug_uq').on(t.slug).where(sql`${t.deletedAt} IS NULL`),
  check('vendors_status_chk', inList('status', VENDOR_STATUSES)),
]);

/** vendor_id NULL => platform staff. Email is globally unique (one login identity per person). */
export const users = pgTable('users', {
  id: pk(),
  vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
  userType: text('user_type').notNull().default('vendor'),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  fullName: text('full_name').notNull(),
  status: text('status').notNull().default('invited'),
  emailVerifiedAt: tz('email_verified_at'),
  lastLoginAt: tz('last_login_at'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: tz('locked_until'),
  version: version(),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  uniqueIndex('users_email_uq').on(sql`lower(${t.email})`).where(sql`${t.deletedAt} IS NULL`),
  unique('users_vendor_id_id_uq').on(t.vendorId, t.id),
  index('users_vendor_idx').on(t.vendorId),
  check('users_status_chk', inList('status', USER_STATUSES)),
  check('users_type_chk', sql`(user_type = 'platform' AND vendor_id IS NULL) OR (user_type = 'vendor' AND vendor_id IS NOT NULL)`),
]);

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(), // e.g. products:write
  module: text('module').notNull(),
  description: text('description'),
});

/** vendor_id NULL => system role (shared, read-only to vendors). */
export const roles = pgTable('roles', {
  id: pk(),
  vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  ...timestamps(),
}, (t) => [
  uniqueIndex('roles_vendor_key_uq').on(sql`coalesce(${t.vendorId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key),
]);

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionKey: text('permission_key').notNull().references(() => permissions.key, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })]);

export const userRoles = pgTable('user_roles', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.roleId] }),
  index('user_roles_vendor_idx').on(t.vendorId),
]);

/** Refresh tokens: hashed at rest, rotated per use, grouped in families for reuse detection. */
export const refreshTokens = pgTable('refresh_tokens', {
  id: pk(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'cascade' }),
  familyId: uuid('family_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: tz('expires_at').notNull(),
  usedAt: tz('used_at'),
  revokedAt: tz('revoked_at'),
  userAgent: text('user_agent'),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
  index('refresh_tokens_user_idx').on(t.userId),
  index('refresh_tokens_family_idx').on(t.familyId),
  index('refresh_tokens_expires_idx').on(t.expiresAt),
]);


export const USER_TOKEN_PURPOSES = ['email_verification', 'password_reset'] as const;

/** One-time tokens e-mailed to users. Only the sha256 hash is stored; consumed atomically (used_at). */
export const userTokens = pgTable('user_tokens', {
  id: pk(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: tz('expires_at').notNull(),
  usedAt: tz('used_at'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('user_tokens_hash_uq').on(t.tokenHash),
  index('user_tokens_user_idx').on(t.userId, t.purpose),
  check('user_tokens_purpose_chk', inList('purpose', USER_TOKEN_PURPOSES)),
]);

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;

/** Vendor membership invitations (role assigned at invite time). */
export const invitations = pgTable('invitations', {
  id: pk(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  roleKey: text('role_key').notNull(),
  tokenHash: text('token_hash').notNull(),
  status: text('status').notNull().default('pending'),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: tz('expires_at').notNull(),
  acceptedAt: tz('accepted_at'),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (t) => [
  uniqueIndex('invitations_hash_uq').on(t.tokenHash),
  uniqueIndex('invitations_pending_uq').on(t.vendorId, sql`lower(${t.email})`).where(sql`${t.status} = 'pending'`),
  index('invitations_vendor_idx').on(t.vendorId, t.createdAt.desc(), t.id),
  check('invitations_status_chk', inList('status', INVITATION_STATUSES)),
]);
