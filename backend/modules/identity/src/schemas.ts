import { z } from 'zod';
import { EmailSchema, GstinSchema, IsoDate, PasswordSchema } from '@oms/contracts';

export const UserSummarySchema = z
  .object({
    id: z.string(),
    email: z.string(),
    fullName: z.string(),
    userType: z.enum(['vendor', 'platform']),
    vendorId: z.string().nullable(),
    roles: z.array(z.string()),
    emailVerified: z.boolean(),
    status: z.string(),
    lastLoginAt: IsoDate.nullable(),
  })
  .meta({ id: 'UserSummary' });

export const VendorSummarySchema = z
  .object({ id: z.string(), displayName: z.string(), slug: z.string(), status: z.string() })
  .meta({ id: 'VendorSummary' });

export const RegisterBodySchema = z.object({
  businessName: z.string().trim().min(2).max(120).meta({ example: 'Acme Apparel' }),
  legalName: z.string().trim().min(2).max(200).optional(),
  fullName: z.string().trim().min(2).max(120).meta({ example: 'Asha Rao' }),
  email: EmailSchema.meta({ example: 'asha@acme.example' }),
  password: PasswordSchema,
  phone: z.string().trim().min(7).max(20).optional(),
  gstin: GstinSchema.optional(),
});

export const LoginBodySchema = z.object({ email: EmailSchema, password: z.string().min(1).max(128) });
export const RefreshBodySchema = z.object({ refreshToken: z.string().min(20).max(200) });
export const TokenBodySchema = z.object({ token: z.string().min(20).max(200) });
export const ForgotBodySchema = z.object({ email: EmailSchema });
export const ResetBodySchema = z.object({ token: z.string().min(20).max(200), password: PasswordSchema });
export const ChangePasswordBodySchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema });
export const UpdateProfileBodySchema = z.object({ fullName: z.string().trim().min(2).max(120) });

export const SessionTokensSchema = z
  .object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string(),
    expiresIn: z.number().int().describe('Access token lifetime in seconds'),
    refreshToken: z.string().describe('Opaque, single-use: exchange it at /auth/refresh for a new pair'),
    sessionId: z.string(),
    user: UserSummarySchema,
    vendor: VendorSummarySchema.nullable(),
  })
  .meta({ id: 'SessionTokens' });

export const RegisteredSchema = z
  .object({ user: UserSummarySchema, vendor: VendorSummarySchema, emailVerificationRequired: z.boolean() })
  .meta({ id: 'Registered' });

export const SessionSchema = z
  .object({ id: z.string(), current: z.boolean(), startedAt: IsoDate, lastActiveAt: IsoDate, userAgent: z.string().nullable(), ip: z.string().nullable() })
  .meta({ id: 'Session' });

export const MessageSchema = z.object({ message: z.string() }).meta({ id: 'Message' });

export const RoleSchema = z
  .object({ key: z.string(), name: z.string(), userType: z.enum(['vendor', 'platform']), permissions: z.array(z.string()) })
  .meta({ id: 'Role' });
