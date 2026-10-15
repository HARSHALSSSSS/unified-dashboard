import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadEnvFiles } from '@oms/config';
import { hashPassword, passwordPolicyViolations } from '@oms/auth';
import { createPlatformUser } from './platform-user';
import * as schema from './schema';

/**
 * CLI: PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... [PLATFORM_ADMIN_NAME=...] pnpm db:create-admin
 * Platform staff are created out-of-band on purpose (never via the public API). Runs with the OWNER role.
 */
loadEnvFiles();
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const email = process.env.PLATFORM_ADMIN_EMAIL;
const password = process.env.PLATFORM_ADMIN_PASSWORD;
if (!url || !email || !password) throw new Error('Set DATABASE_MIGRATION_URL, PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD');
const problems = passwordPolicyViolations(password);
if (problems.length) throw new Error(`Password ${problems.join(', ')}`);

const pool = new pg.Pool({ connectionString: url, max: 1 });
const res = await createPlatformUser(drizzle(pool, { schema }), {
  email,
  fullName: process.env.PLATFORM_ADMIN_NAME ?? 'Platform Admin',
  passwordHash: await hashPassword(password),
});
await pool.end();
console.log(`${res.created ? 'created' : 'updated'} platform admin ${email} (${res.id})`);
