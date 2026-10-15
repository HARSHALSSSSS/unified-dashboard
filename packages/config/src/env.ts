import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

/**
 * Environment schema, grouped by concern. Validated once at process start (fail fast).
 * Per-vendor marketplace credentials are NOT process env: they live encrypted in the database.
 * Only platform-level OAuth *app* credentials (one set per marketplace) are env / secret-manager values.
 */
export const envSchema = z.object({
  // ---- application
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_NAME: z.string().default('oms'),
  APP_VERSION: z.string().default('0.0.0'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: csv.default(['http://localhost:5173']),
  /**
   * Which proxies' X-Forwarded-For to believe: false | a number of trusted hops (1 = exactly one load balancer in front) | a comma
   * separated list of proxy CIDRs. 'true' (believe every hop, so a client can spoof its IP and dodge rate limits) is accepted
   * outside production only.
   */
  TRUST_PROXY: z.string().default('false').transform((v): boolean | number | string[] => {
    const t = v.trim().toLowerCase();
    if (t === 'false' || t === '0' || t === '') return false;
    if (t === 'true') return true;
    if (/^\d+$/.test(t)) return Number(t);
    return v.split(',').map((x) => x.trim()).filter(Boolean);
  }),
  SWAGGER_ENABLED: bool.optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().default(10),
  METRICS_ENABLED: bool.default(true),
  METRICS_TOKEN: z.string().optional(),

  // ---- database
  DATABASE_URL: z.string().url(),
  DATABASE_MIGRATION_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().default(10),
  DATABASE_POOL_IDLE_MS: z.coerce.number().int().default(30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(15_000),
  DATABASE_SSL: bool.default(false),

  // ---- redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_KEY_PREFIX: z.string().default('oms'),

  // ---- object storage (S3 compatible: AWS S3 / MinIO / R2)
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('s3'),
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().default('ap-south-1'),
  STORAGE_BUCKET: z.string().default('oms-media'),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: bool.default(false),

  // ---- auth / security
  JWT_ISSUER: z.string().default('oms'),
  JWT_AUDIENCE: z.string().default('oms-api'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().default(60 * 60 * 24 * 30),
  /** `keyId:base64(32 bytes)` entries, comma separated. The first entry is the active key; others decrypt only (rotation). */
  ENCRYPTION_KEYS: z.string().min(1),
  WEBHOOK_SIGNING_TOLERANCE_SECONDS: z.coerce.number().int().default(300),
  /** Invitations and marketplace connections require a verified e-mail address. */
  EMAIL_VERIFICATION_REQUIRED: bool.default(true),
  /** Base URL of the web app, used in e-mailed links (verify, reset, invitation). */
  APP_WEB_URL: z.string().url().default('http://localhost:5173'),
  /** Built-in mock/sandbox marketplace connector. Always allowed outside production; opt-in in production. */
  MOCK_MARKETPLACE_ENABLED: bool.optional(),
  /** Built-in sandbox courier and its /shipments/{id}/simulate endpoint. Always allowed outside production; opt-in in production. */
  SANDBOX_COURIER_ENABLED: bool.optional(),

  // ---- marketplace connectors / sync engine
  /** Bounded in-call retries (transient / 429) inside the connector host. */
  CONNECTOR_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  CONNECTOR_RETRY_BASE_MS: z.coerce.number().int().min(0).default(250),
  CONNECTOR_RETRY_MAX_MS: z.coerce.number().int().min(0).default(5000),
  /** Upper bound on how long we honour a marketplace Retry-After inside one call (longer waits belong to the job retry). */
  CONNECTOR_RETRY_AFTER_CAP_MS: z.coerce.number().int().min(0).default(10_000),
  /** No single marketplace call may run longer than this. */
  CONNECTOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  /** Consecutive infrastructure failures that open a marketplace account's circuit breaker, and how long it stays open. */
  CONNECTOR_BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(50).default(5),
  CONNECTOR_BREAKER_OPEN_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Sync jobs: attempts before dead-lettering, and the exponential backoff between attempts. */
  SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  SYNC_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(30_000),
  SYNC_BACKOFF_MAX_MS: z.coerce.number().int().min(0).default(15 * 60_000),
  /** Webhook processing: attempts before dead-lettering. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  /** Days of webhook event history kept. */
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  /** Public base URL marketplaces call back (shown in webhook configuration). */
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),

  // ---- AI (optional narrator; answers are always computed from real data)
  AI_PROVIDER: z.enum(['rules', 'anthropic']).default('rules'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5-5'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),

  // ---- observability
  OTEL_ENABLED: bool.default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SENTRY_DSN: z.string().optional(),

  // ---- workers
  WORKER_CONCURRENCY: z.coerce.number().int().default(10),
  WORKER_HEALTH_PORT: z.coerce.number().int().default(3100),

  // ---- platform-level third-party credentials (marketplace OAuth apps, not vendor tokens)
  AMAZON_IN_LWA_CLIENT_ID: z.string().optional(),
  AMAZON_IN_LWA_CLIENT_SECRET: z.string().optional(),
  FLIPKART_APP_ID: z.string().optional(),
  FLIPKART_APP_SECRET: z.string().optional(),
  MYNTRA_PARTNER_ID: z.string().optional(),
  MYNTRA_PARTNER_SECRET: z.string().optional(),
  SNAPDEAL_PARTNER_ID: z.string().optional(),
  SNAPDEAL_PARTNER_SECRET: z.string().optional(),
  SMTP_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
