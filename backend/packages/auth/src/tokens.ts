import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, newId, type Principal } from '@oms/shared';

/**
 * Token strategy
 * - Access token: short-lived (15 min) signed JWT (HS256, 256-bit secret). Stateless verification on every request.
 *   Claims carry identity + tenant + role KEYS (not the permission list) so tokens stay small; permissions are
 *   resolved from a cached role->permission map, so permission changes take effect without waiting for expiry.
 * - Refresh token: opaque 256-bit random value, stored HASHED (sha256) in `refresh_tokens`, rotated on every use,
 *   grouped by `family_id`. Re-use of a rotated token revokes the whole family (theft detection).
 */
export interface AccessTokenClaims {
  sub: string; // user id
  vid: string | null; // vendor id (tenant), null for platform staff
  utp: 'vendor' | 'platform';
  rol: string[];
  sid: string; // session (refresh token family) id
}

export interface TokenConfig {
  issuer: string;
  audience: string;
  secret: string;
  accessTtlSeconds: number;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(cfg: TokenConfig, claims: AccessTokenClaims): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({ vid: claims.vid, utp: claims.utp, rol: claims.rol, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setJti(newId())
    .setIssuedAt()
    .setExpirationTime(`${cfg.accessTtlSeconds}s`)
    .sign(key(cfg.secret));
  return { token, expiresIn: cfg.accessTtlSeconds };
}

export async function verifyAccessToken(cfg: TokenConfig, token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key(cfg.secret), {
      issuer: cfg.issuer,
      audience: cfg.audience,
      algorithms: ['HS256'], // pin the algorithm: never accept 'none' or alg confusion
    });
    if (!payload.sub || typeof payload.sid !== 'string') throw new Error('malformed claims');
    return {
      sub: payload.sub,
      vid: (payload.vid as string | null | undefined) ?? null,
      utp: payload.utp === 'platform' ? 'platform' : 'vendor',
      rol: Array.isArray(payload.rol) ? (payload.rol as string[]) : [],
      sid: payload.sid,
    };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw new AppError('TOKEN_EXPIRED');
    throw new AppError('TOKEN_INVALID');
  }
}

export interface RefreshToken { token: string; hash: string }

export function generateRefreshToken(): RefreshToken {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}
export const hashRefreshToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Build the request Principal from verified claims + the resolved permission set. */
export function principalFromClaims(c: AccessTokenClaims, permissions: ReadonlySet<string>): Principal {
  return {
    actorType: 'user',
    actorId: c.sub,
    userType: c.utp,
    vendorId: c.vid,
    roles: c.rol,
    permissions,
    sessionId: c.sid,
  };
}
