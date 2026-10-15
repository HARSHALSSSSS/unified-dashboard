import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadEnvFiles } from '@oms/config';
import { seedReferenceData } from './reference-data';
import * as schema from './schema';

/** CLI: `pnpm db:seed`. Runs with the OWNER role (DATABASE_MIGRATION_URL). Safe to run on every deploy. */
loadEnvFiles();
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set');

const pool = new pg.Pool({ connectionString: url, max: 1 });
const result = await seedReferenceData(drizzle(pool, { schema }));
await pool.end();
console.log(`seeded ${result.permissions} permissions and ${result.roles} system roles`);
