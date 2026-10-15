import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost/oms' },
  strict: true,
  verbose: true,
});
