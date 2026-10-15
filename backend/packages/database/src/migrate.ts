import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { loadEnvFiles } from '@oms/config';

/**
 * Runs pending migrations using the OWNER role (DATABASE_MIGRATION_URL). The runtime role (DATABASE_URL)
 * is a non-owner, non-superuser role so row-level security always applies to the application.
 */
loadEnvFiles();
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set');

const pool = new pg.Pool({ connectionString: url, max: 1 });
const folder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
await migrate(drizzle(pool), { migrationsFolder: folder });
await pool.end();
console.log('migrations applied');
