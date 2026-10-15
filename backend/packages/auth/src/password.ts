import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id, parameters follow OWASP 2024 guidance (m=19 MiB, t=2, p=1 minimum).
 * We use stronger memory by default; tune per deployment via the options object if latency matters.
 */
const ARGON_OPTS = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string): Promise<string> => hash(plain, ARGON_OPTS);

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/** Verify against a throwaway hash so "unknown user" and "wrong password" cost the same time (anti user-enumeration). */
let dummyHash: Promise<string> | undefined;
export const verifyDummy = async (plain: string): Promise<void> => {
  dummyHash ??= hashPassword('oms-dummy-password-for-timing');
  await verifyPassword(await dummyHash, plain);
};

/** Minimal policy; extend (breach-list check, zxcvbn) in the identity module. */
export function passwordPolicyViolations(plain: string): string[] {
  const v: string[] = [];
  if (plain.length < 10) v.push('must be at least 10 characters');
  if (plain.length > 128) v.push('must be at most 128 characters');
  return v;
}
