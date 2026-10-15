import { z } from 'zod';
import { EmailSchema, IsoDate, PaginationQuerySchema, PasswordSchema, SearchQuerySchema, sortQuery } from '@oms/contracts';

export const VENDOR_ROLE_KEYS = ['vendor_admin', 'vendor_staff', 'vendor_viewer'] as const;
export const VendorRoleKeySchema = z.enum(VENDOR_ROLE_KEYS);

export const MemberSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    fullName: z.string(),
    status: z.enum(['invited', 'active', 'disabled']),
    roleKey: z.string().nullable().describe('The member\'s (single) vendor role'),
    emailVerified: z.boolean(),
    lastLoginAt: IsoDate.nullable(),
    createdAt: IsoDate,
  })
  .meta({ id: 'Member' });

export const MemberListQuerySchema = PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({
  'filter[status]': z.enum(['invited', 'active', 'disabled']).optional(),
  'filter[role]': VendorRoleKeySchema.optional(),
  sort: sortQuery(['createdAt', 'fullName', 'email'] as const),
});

export const UpdateMemberBodySchema = z
  .object({ roleKey: VendorRoleKeySchema, status: z.enum(['active', 'disabled']), fullName: z.string().trim().min(2).max(120) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const InvitationSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    roleKey: z.string(),
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    expiresAt: IsoDate,
    acceptedAt: IsoDate.nullable(),
    invitedBy: z.string().nullable(),
    createdAt: IsoDate,
  })
  .meta({ id: 'Invitation' });

export const InviteBodySchema = z.object({ email: EmailSchema.meta({ example: 'staff@acme.example' }), roleKey: VendorRoleKeySchema.default('vendor_staff') });

export const InvitationListQuerySchema = PaginationQuerySchema.extend({
  'filter[status]': z.enum(['pending', 'accepted', 'revoked', 'expired']).optional(),
});

export const AcceptInvitationBodySchema = z.object({
  token: z.string().min(20).max(200),
  fullName: z.string().trim().min(2).max(120),
  password: PasswordSchema,
});

export const AcceptedSchema = z
  .object({ user: MemberSchema, vendor: z.object({ id: z.string(), displayName: z.string() }) })
  .meta({ id: 'InvitationAccepted' });
