import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { envSchema, type Env } from './env';
import { assertProductionReadiness } from './production';

export { assertProductionReadiness } from './production';

export { envSchema } from './env';
export type { Env } from './env';

export interface AppConfig extends Env {
  isProd: boolean;
  isTest: boolean;
  isDev: boolean;
  swaggerEnabled: boolean;
  mockMarketplaceEnabled: boolean;
  sandboxCourierEnabled: boolean;
}

/**
 * Load order (first wins; real environment variables always win over files):
 *   .env.<NODE_ENV>.local -> .env.<NODE_ENV> -> .env
 * Staging/production inject real environment variables (secret manager) and ship no .env files.
 */
export function loadEnvFiles(cwd = process.cwd(), nodeEnv = process.env.NODE_ENV ?? 'development'): void {
  // Walk up so apps started from apps/<x> still find the repo-root file.
  for (const dir of [cwd, resolve(cwd, '..'), resolve(cwd, '../..')]) {
    for (const f of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, '.env']) {
      const p = resolve(dir, f);
      if (existsSync(p)) loadDotenv({ path: p, override: false, quiet: true });
    }
  }
}

export function parseConfig(source: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';
  if (isProd || env.NODE_ENV === 'staging') assertProductionReadiness(env, isProd);
  return {
    ...env,
    isProd,
    isTest: env.NODE_ENV === 'test',
    isDev: env.NODE_ENV === 'development',
    // Interactive docs are on everywhere except production unless explicitly enabled.
    swaggerEnabled: env.SWAGGER_ENABLED ?? !isProd,
    mockMarketplaceEnabled: env.MOCK_MARKETPLACE_ENABLED ?? !isProd,
    sandboxCourierEnabled: env.SANDBOX_COURIER_ENABLED ?? !isProd,
  };
}

let cached: AppConfig | undefined;
export function loadConfig(): AppConfig {
  if (!cached) {
    loadEnvFiles();
    cached = parseConfig(process.env);
  }
  return cached;
}
